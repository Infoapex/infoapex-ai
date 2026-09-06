# ADR-0005: Explicit planner provider selection and provenance

Status: accepted (2026-09-05)

## Context

The original `propose` command instantiated `createClaudeAdapter` directly.
That allowed a CLI default model to create a plan without an explicit human
selection, preflight, effort declaration, or comparable provenance. It was not
a multi-provider planner despite the product claim that it routes work across
model families.

## Decision

1. Provider adapters are registered under stable IDs: `codex` and `claude`.
2. `propose` and `preflight` require provider, model, reasoning effort,
   selection reason, and an operator-declared estimated cost cap.
3. No provider/model/effort has a runtime default. Missing selection blocks
   before the provider is invoked.
4. The Codex adapter invokes authenticated `codex exec` in ephemeral,
   read-only mode, with an explicit model, effort configuration, output schema,
   and bounded output/time.
5. The Claude adapter passes explicit `--model` and `--effort`; it never passes
   Claude CLI's automatic `--fallback-model` option.
6. Fallback data is optional provenance for a separate authorization. The
   current invocation never automatically retries another provider/model.
7. `planningProvenance` records the requested and resolved model separately,
   effort, selection reason, fallback approval, estimated cap, provider usage,
   and duration. An estimate is never represented as actual billed cost.

## Consequences

This changes the CLI contract. Existing invocations that relied on Claude's
default model must become explicit. It also means a plan cannot claim that a
model was subscription-available until the selected live invocation succeeds.
The adapter registry is extensible, but adding an adapter requires bounded
execution, explicit selection, preflight behavior, provenance mapping, and
tests; a registry entry alone is not sufficient.
