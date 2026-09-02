# ADR 0012: Redacted OpenTelemetry tracing over the existing event log

- Status: Accepted
- Date: 2026-09-03

## Context

`docs/plans` on the bundle side (`infoapex-ai/docs/plans/INFOAPEX-AI-ROADMAP-P0-P5.md`,
section 9) lists "OpenTelemetry fără conținut sensibil" as the first-recommended P5
subproject: post-stabilization, high effort, requiring its own ADR, threat model,
versioned contract, and negative tests before it can be considered done - P5 is
explicitly not one milestone, and this is one subproject of it.

The worker already has a complete, schema-validated event stream: `EventLog`
(`src/persistence/event-log.ts`) appends a `RunEvent` for every lifecycle step (compile,
authorize, per-task execution, gates, repair, review, done/blocked) to
`<runRoot>/events.jsonl`, validated against `schemas/event.schema.json`. Payloads are
already disciplined: `tests/unit/security-redaction.test.ts` asserts every string value
in every event payload is free of secret-shaped substrings (API keys, tokens,
passwords), and command output is never carried past a `redactText(...).sha256` (see
`src/runner/quality-gate.ts`) - raw stdout/stderr, prompts, and environment variables
never reach an event payload today. One residual gap: some payloads carry filesystem
paths (`task.worktree-created`'s `path`, `task.committed`'s `changedPaths`), which can
embed a local username on Windows (`C:\Users\<name>\...`) or `$HOME`. That is not a
secret leak in the `redactText` sense, but it is exactly the kind of "sensitive content"
this subproject's own name commits to keeping out.

## Decision

### Threat model

What must never appear in an exported span: prompt/task-description text, file
contents, environment variables, raw command stdout/stderr, secrets/API keys/tokens,
and filesystem paths that can embed a local username. What is acceptable: run/task/gate
IDs, commit SHAs, exit codes, failure classifications, content hashes (`outputSha256`),
counts, enums/status strings, and durations - the same class of data the event log
payloads already carry deliberately.

The control is an **allowlist**, not a denylist: `src/telemetry/redact-attributes.ts`'s
`toSpanAttributes()` keeps only a fixed, named set of payload keys (`taskId`, `gateId`,
`runId`, `commit`, `exitCode`, `failureClass`, `outputSha256`, and similar), and applies
`redactText()` to every string value that survives the allowlist as defense in depth.
Any key not on the list - including `path`, `changedPaths`, or any field a future event
type adds - is dropped by construction, not by remembering to exclude it. Array-valued
fields (e.g. `changedPaths`) are converted to a count (`changedPathCount`) rather than
included, closing the one residual path-leak gap identified above. This is the same
shape of guarantee `tests/unit/security-redaction.test.ts` already enforces for event
payloads, extended to span attributes with its own dedicated negative test
(`tests/unit/telemetry-redaction.test.ts`).

### Integration point: `EventLog`, not the run files

`EventLog.append()` is the single choke point every lifecycle event already passes
through, regardless of engine (`fake-run.ts`, `claude-run.ts`, `codex-run.ts`) or phase
(`compile.ts`). `EventLog` gains one optional constructor parameter, a `RunTelemetry`
sink, invoked after an event is schema-validated and durably written:

```ts
new EventLog(path, registry, telemetry)
```

No other line in any of the four call sites changes beyond passing that third argument.
This is deliberate: those files run today's real engine executions and are exercised by
the bulk of the existing test suite; touching their control flow to add manual
span-lifecycle management would risk the exact thing this ADR's own exit gate forbids -
weakening standalone functioning or existing guardrails for the sake of an optional,
opt-in feature.

### Every event becomes an immediately-exported span

Rather than holding one long-lived "run span" open across the whole run (which would
only export if something remembers to end it, and end it exactly once, from every
return path across ~1200-line run files), `RunTelemetry.onEvent()` treats each `RunEvent`
one of two ways:

- **Paired lifecycle events** (`task.started`/`task.finished`, `gate.started`/
  `gate.finished`, `repair.attempt-started`/`repair.attempt-finished`) become one real
  span with a genuine duration, correlated by an in-memory map keyed on the relevant
  payload IDs (`taskId`, `taskId`+`gateId`, `taskId`+`attempt`). Gate and repair-attempt
  spans nest under their task's span when one is open; task spans nest under a synthetic
  per-run root context (below).
- **Every other event type** (the majority - `run.created`, `manifest.compiled`,
  `task.committed`, `review.finished`, `run.done`, ...) becomes its own zero-duration
  point span, exported the instant it is recorded.

The consequence: a span is exported the moment its data is available, with no
"remember to close this" state that could leak across process exit, an early `BLOCKED`
return, or a resumed run that never re-emits the event that would have closed it. An
unmatched `*.started` with no later `*.finished` (a run that crashes mid-task) simply
never produces its paired span end - it is absent from the trace, not exported half-open
or hung indefinitely.

### One trace per run, without a live cross-phase parent object

`compile.ts` and each run file construct independent `EventLog` instances against the
same `events.jsonl` path (`compile.state.eventLogPath`), so there is no single in-memory
object spanning both phases to hold a "run root span." Instead, `createRunTelemetry()`
derives a deterministic trace ID and a synthetic (non-recording, non-exported) root span
ID from `runId` alone (`sha256("otel-trace:" + runId)`, `sha256("otel-root-span:" +
runId)`), then uses `trace.setSpanContext()` to inject that as every span's ultimate
ancestor context. Two independently-constructed `RunTelemetry` instances for the same
`runId` therefore still produce spans sharing one trace ID, without either instance
knowing the other exists. This is a narrower guarantee than a single live parent span
(there is no "run" span itself with its own start/end and status), and that is
deliberate: it avoids the exact lifecycle problem above. A future iteration could add a
real run-level span once there is a single object that legitimately owns the whole run's
lifetime end to end.

### Export: local file by default, real OTLP explicitly opt-in

Disabled by default (`INFOAPEX_OTEL_ENABLED` unset): `createRunTelemetry()` returns a
no-op `RunTelemetry` and never constructs a `TracerProvider` - zero behavioral or
performance difference from before this ADR.

Enabled (`INFOAPEX_OTEL_ENABLED=1`): spans export to `<runRoot>/otel-spans.jsonl` via a
custom `LocalFileSpanExporter`, schema-validated against `schemas/otel-span.schema.json`
(the "contract versionat" this subproject's exit gate requires) using
`BasicTracerProvider` + `SimpleSpanProcessor`. `SimpleSpanProcessor` exports synchronously
inside `span.end()` - by design, since this module's run functions
(`runFake`/`runClaude`/`runCodex`) are synchronous end to end and must stay that way; a
batching/async exporter would need `provider.shutdown()` awaited from inside those
functions, which is the same invasive control-flow change already rejected above. Wiring
a real collector (`@opentelemetry/exporter-trace-otlp-http`, driven by
`OTEL_EXPORTER_OTLP_ENDPOINT`) is a natural follow-up - swapping the exporter behind
`RunTelemetry` - but is out of scope here specifically because that exporter is
network-bound and would need the async shutdown this ADR avoids. Local, offline,
zero-network export is the complete v1, not a placeholder for one.

## Consequences

- Standalone module usage is unaffected: default-disabled, and even when enabled, no
  call site's control flow changes beyond one extra constructor argument.
- The trace produced when enabled is real OpenTelemetry (`@opentelemetry/api` spans,
  attributes, trace/span IDs) and can be redirected to any OTLP-compatible backend later
  by replacing the exporter, without touching `EventLog` or any run file again.
- No run-level (whole-run) span exists yet; a trace is the union of point spans and
  task/gate/repair spans correlated by trace ID, not a single root span with its own
  status. Documented here rather than left implicit, per this project's practice of
  stating scope boundaries instead of quietly shipping a partial version of something
  named more broadly.
- The path-leak gap identified in Context is closed for span attributes specifically
  (allowlist drops `path`/`paths`-shaped fields); it is not retroactively closed for the
  existing event log itself, which was already covered by its own test guaranteeing no
  secret-shaped strings, and is out of scope for a tracing ADR to silently change.
