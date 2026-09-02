# ADR-0003: Unified root CLI — command ownership and delegation contract

- Status: accepted
- Date: 2026-09-03

## Context

P4 in `docs/plans/INFOAPEX-AI-ROADMAP-P0-P5.md` calls for extending the root
`infoapex-ai` CLI from `init | status | handoff` to a coherent surface:

```text
infoapex-ai doctor
infoapex-ai plan
infoapex-ai run
infoapex-ai status
infoapex-ai resume
infoapex-ai review
infoapex-ai docs
```

with an explicit first step: "ADR pentru ownership-ul comenzilor și contractul de
delegare" — before any implementation, because the naming surface as stated collides
with existing, already-shipped module commands in ways that are not obvious from the
roadmap list alone. Verified directly against each module's built CLI (not assumed):

- `ai-code-planner`: `propose | inspect | compile | explain-routing |
  ingest-worker-report | replan` — no `plan` subcommand at all; plan *creation* is
  `propose`.
- `ai-code-worker`: `benchmark | init | update | doctor | status | compile | run |
  review` — has both `doctor` and `status`, with `status` requiring `--run-id` (run
  state), a different concept from the root's existing `status` (integration mode
  config, no run concept).
- `ai-code-review`: `init | plan | run | ingest | doctor` — `plan` and `doctor` exist
  here too, but `plan` is an internal review-drafting step, not "create a task plan."
- `ai-code-docs`: `init | plan | generate | doctor | ingest` — same `plan`/`doctor`
  collision, plus the user-facing verb is `generate`, not `docs`.
- Envelope shapes are already inconsistent across modules: `ai-code-review`/
  `ai-code-docs` return `{"status":"BLOCKED","message":...}` JSON even for a plain
  usage error; `ai-code-worker` prints a bare text line (`Missing required option:
  --plan <path>`) and sets `process.exitCode` with no JSON at all unless `--json` is
  also passed.

No module has an aggregate "doctor" or any "resume" concept. `ai-code-worker run`
already resumes an existing `--run-id` automatically via its own checkpoint/recovery
system (confirmed: `--plan` remains a required argument even when resuming - there is
no "resume without re-stating the run" shortcut today).

## Decision

### Command ownership

| Root command | Delegates to | Notes |
|---|---|---|
| `doctor` | **aggregate**: runs `doctor` on every module present (`ai-code-worker doctor`, `ai-code-review doctor`, `ai-code-docs doctor`) and reports one combined result | Not a new health check - just fans out to what already exists per module, since no module can see past its own boundary. |
| `plan` | `ai-code-planner propose` (draft only, not chained into `compile`) | The *only* meaning of `plan` at root: "produce a draft task plan." Deliberately does NOT auto-chain into `inspect`/`compile`: the README's own quick-start treats those as separate, human-reviewed steps before a plan is frozen for the worker - auto-chaining would silently remove that checkpoint. Review/docs's own internal `plan` subcommands remain internal to those modules, never exposed under this name at root. |
| `run` | `ai-code-worker run` | Direct passthrough. |
| `status` | **unchanged** - the existing root `status` (`.infoapex-ai/config.json`: mode, handoff config) | Explicitly NOT merged with `ai-code-worker status` (run state, requires `--run-id`) - different concept, different required inputs, no natural single contract. Run state is reached through `resume` instead (see below), not by overloading `status`. |
| `resume` | `ai-code-worker status --run-id <id>` (existence/state check) then `ai-code-worker run` (same args) | Requires `--run-id` explicitly (unlike `run`, where it is optional) precisely so `resume` can validate the run already exists and give a clear error if it does not, instead of silently starting a new one under that id. |
| `review` | `ai-code-review run` | The root verb is `review`; the module's own internal verb (`run`) is not renamed inside that module, only at the root delegation layer. |
| `docs` | `ai-code-docs generate` | Same pattern: root verb `docs`, module verb `generate`. |

### Delegation mechanism

Root CLI **spawns each module's own built CLI as a subprocess** (`node
modules/<name>/dist/src/cli.js ...args`, or `dotnet ... AiCodeControl.Cli.dll` for
`ai-code-control`) and never imports module source directly. This is not a
convenience choice - it is the literal exit-gate requirement ("root CLI nu importă
source code din module") and the only way to keep the bundle's own load-bearing rule
intact: modules do not import each other's source, communicating only through CLIs,
JSON, files, and versioned schemas (README, "Modulele").

A small versioned registry (`src/registry.ts`) declares, per module: its name, its
CLI entry point relative to the bundle root, and which root commands it backs. This
is the "registry versionat de module/capabilități" from the roadmap's step 2 - a
data file, not a mechanism for discovering *new* capabilities dynamically. Adding a
root command for a module still requires a code change; the registry's job is to
give every command handler one consistent place to resolve "where is this module's
CLI," not to make the command set self-extending.

### JSON envelope and exit codes

Every root command produces:

```json
{
  "schemaVersion": "1.0",
  "command": "<root command name>",
  "module": "<delegated module name, or null for aggregate/root-only commands>",
  "status": "PASS" | "WARN" | "BLOCKED",
  "exitCode": 0 | 1 | 2,
  "body": <the delegated module's own raw JSON output, verbatim, or null if the module never produced parseable JSON>
}
```

`status`/`exitCode` are derived from the delegated process's own exit code and, where
present, its own `status`/`schemaVersion` JSON field - never re-interpreted or
second-guessed: a module reporting `BLOCKED` is `BLOCKED` at the root too, not
silently downgraded to a warning. When a module's stdout is not valid JSON (the
`ai-code-worker` bare-text case above), `body` is `null` and a `findings`-shaped
diagnostic is added noting the raw stderr/stdout tail - this is what step 5's
"Envelope JSON și exit codes comune" actually closes: not changing what modules
themselves output (that stays each module's own contract, verified independently),
but guaranteeing the root CLI's *own* output is always one consistent, parseable
shape regardless of which module answered.

### Missing module handling

If a registry-declared module's CLI entry point does not exist on disk (not built,
or a stripped-down fork), the root command returns `status: "BLOCKED"`, a
`MODULE_NOT_AVAILABLE` finding naming the missing module and its expected path, and
exit code 2 - never a silent no-op and never a fallback to a different module.

## Consequences

- `plan`, `review`, and `docs` at the root are intentionally different verbs than the
  module-internal commands they delegate to (`propose`, `run`, `generate`). This is a
  one-time naming translation documented here, not a renaming of the modules' own
  standalone contracts - each module keeps its existing CLI unchanged and independently
  testable, per ADR-0001.
- `resume`'s requirement to re-supply the full original `run` arguments (plan, engine,
  etc.) is a real limitation, not hidden: there is no persisted "replay this exact
  run" shortcut in `ai-code-worker` today. If that gap is closed upstream later, this
  ADR's `resume` delegation gets simpler, not different in shape.
- `doctor`'s aggregate behavior means a root `doctor` run's exit code reflects the
  worst status across all present modules' own doctor checks - a single module being
  unavailable/misconfigured blocks the aggregate result, matching "absența unui modul
  produce un diagnostic clar, nu fallback ascuns."
- The registry is intentionally static/versioned, not a plugin system - extending the
  root CLI to a new module or command is still a code change and a new bundle release,
  consistent with this project's "no dynamic capability discovery" stance elsewhere
  (ADR-0011 in `ai-code-control`, cited via the trace-graph ADR precedent).
