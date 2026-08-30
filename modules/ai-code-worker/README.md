# ai-code-worker

`ai-code-worker` is an independent coding-worker orchestrator shipped inside
the `infoapex-ai` bundle. It is invoked only when a user explicitly asks a
coding task or accepted plan to be implemented by the worker.

The repository currently contains the v1.2 implementation plan, its safety/recovery amendment, accepted ADRs, public JSON contracts, consumer-project templates, deterministic Phase 0 runtime coverage, Phase 1/2 runtime paths, dynamic engine discovery, bounded per-task context injection, per-task routing snapshots, bounded availability fallback, and optional infoapex-ai handoff feedback.

## Core Decision

The worker is independent from `ai-code-control`.

- `ai-code-worker/` is the versioned engine repository.
- `.ai-code-worker/` in a consumer project contains only versioned local configuration.
- Operational state such as runs, worktrees, logs, caches, and SQLite indexes lives under an OS-local external `stateRoot`.
- `ai-code-control` is an optional context provider through CLI JSON and exit codes, never a code or SQLite dependency.
- Autonomous writers require an immutable run authorization and an isolated execution profile by default.
- Every dependent task runs from a deterministic input snapshot built from its dependency closure.

## Repository Contents

- `docs/IMPLEMENTATION-PLAN.md` - v1.2 implementation plan.
- `docs/amendments/v1.2-safety-execution-and-recovery.md` - normative v1.2 amendment.
- `docs/adr/` - accepted architecture decisions for hooks, isolation, authorization, snapshots, streaming adapters, and recovery.
- `schemas/` - public JSON contracts for config, manifests, authorization, execution environments, task snapshots, engine/run events, evidence, review, and pilot baseline.
- `templates/project/.ai-code-worker/` - files copied into consumer repositories by the future `init` command.
- `templates/reports/` - evidence and report examples.
- `scripts/validate-json.mjs` - dependency-free structural validation used by `npm test`.

## Phase 0 Scope

Phase 0 should implement only deterministic foundations:

- schema validation and fixtures;
- authorization, instruction trust, execution environment, dependency snapshot, and engine-event contracts;
- config and plan metadata parsing;
- external state-root resolution;
- sync-root and Git common-directory detection;
- event log and replay model;
- policy checks for paths, commands, budgets, and evidence;
- fake engine and fixture repositories for CI;
- `doctor`, `compile`, and `status`.

No real AI engine should write code until these foundations are covered by tests. A real pilot additionally requires the minimum recovery kernel from Phase 1.

## Bundle Installation Shape

```powershell
npm ci --prefix modules/ai-code-worker
npm test --prefix modules/ai-code-worker
node modules/ai-code-worker/dist/cli.js init --engines codex,claude
```

Until `init` is implemented, copy the template directory manually only for design review:

```powershell
Copy-Item -Recurse ai-code-worker/templates/project/.ai-code-worker .ai-code-worker
```

## Development usage benchmarks

The worker can record bounded start/end checkpoints for work performed in a Codex
session. Checkpoints contain numeric usage, model/effort metadata, a short session
fingerprint, and an optional preregistered prediction. Raw rollout text is never
copied into benchmark state.

`percentUsedReported` always means consumed capacity: it starts at `0` and grows.
Remaining capacity is `100 - percentUsedReported`. The CLI prints both values to
avoid confusing “98% remaining” with “98% used”. Token deltas and percentage-point
deltas are compared only inside the same model/effort, session fingerprint and
unchanged rate-limit window. See `docs/USAGE-TELEMETRY-V1.md` for completeness and
cumulative-event accounting semantics.

```powershell
node modules/ai-code-worker/dist/src/cli.js benchmark checkpoint --repo . --plan ICM --stage ICM-01 --phase start --engine codex --kind contract --risk high --predicted-low 1400000 --predicted-median 1900000 --predicted-high 2400000 --prediction-source ICM-plan-v1
node modules/ai-code-worker/dist/src/cli.js benchmark checkpoint --repo . --plan ICM --stage ICM-01 --phase end --engine codex
node modules/ai-code-worker/dist/src/cli.js benchmark drift --repo . --plan ICM --profile codex:gpt-5.6-sol:high
```

## Compiled context packages

Context packages are opt-in and use the existing CLI/JSON `ai-code-control` adapter;
the worker never reads its SQLite databases or .NET types directly.

```json
{
  "contextProvider": "ai-code-control",
  "contextPackage": {
    "mode": "observe",
    "maximumTokens": 12000
  },
  "adapters": {
    "aiCodeControl": {
      "executable": "ai-code-control",
      "timeoutSeconds": 30,
      "maximumOutputBytes": 2000000
    }
  }
}
```

- `off` preserves the existing context-provider behavior and creates no package.
- `observe` compiles, independently validates and exports packages without changing
  the engine prompt.
- `enforce` is fail-closed and available only for Codex/Claude runs. The engine prompt
  receives the validated package instead of legacy provider output.

Packages are written to `tasks/<taskId>/context-package.v1.json`; the run-level
`context-package-index.v1.json` records status, digest, artifact path and source
provenance. The consumer recomputes the producer digest, checks run/task/manifest
binding, rejects blocking diagnostics and refuses unredacted secret-looking content.

## Semantic snapshots and incremental invalidation

`task-input.json` schema v1.1 binds dependency commits to the compiled context digest,
context compiler version, selected contract hashes, relevant quality-gate config,
scope/routing policy, and selected toolchain config. Hashes are canonical and contain
repository-relative identities only.

The incremental planner reexecutes a task only when one of these declared semantic
inputs or a dependency commit changes. It reports descendants separately: they become
stale only when the reexecuted dependency produces a different verified commit.
Changes to unselected files, source discovery order, timestamps, package IDs, or
checkout paths do not invalidate a task. Terminal runs stay immutable and use a new
graph revision rather than being reopened in place; see ADR 0010.

## Semantic source maps

Traceable worker-contract v1.1 runs write `source-map.v1.json` before DONE. Stable nodes
and edges join context sources, criteria, tasks, changed files, commits, gates and
evidence using only declared or observed relations. The worker never emits an automatic
`caused` edge.

Glass-box enforcement requires every criterion and gate ID to survive the
planner-to-worker-to-evidence boundary and every PASS criterion to have a linked command
with exit code zero. Missing IDs or evidence block DONE. A source marked `proposed` may
remain advisory context but cannot verify or authorize a verdict. The artifact is
schema-validated and digest-protected; Obsidian is a possible viewer, not its source of
truth.

The drift report separates token-prediction comparability from usage-percentage
mapping. Model/session changes, non-monotonic counters, and parallel sessions make the
token delta `NOT_COMPARABLE`. A rate-limit reset invalidates only tokens-per-percentage-
point; a same-session cumulative token delta remains usable for predicted-versus-actual
error. Checkpoint schema v1.1 remains read-compatible with legacy v1.0 log entries.

## Validation

```powershell
npm test
```

The test suite builds the TypeScript runtime, validates JSON contracts, and runs deterministic unit and E2E coverage for the Phase 0 path.

To run the local Phase 0 demo:

```powershell
npm run phase0:demo
```

The demo creates a temporary fixture repository and executes `doctor -> compile -> status`, then `run --engine fake -> status`, without starting a real writer.

## Status

Status: Phase 1/2 MVP plus routing, fallback and optional Infoapex AI handoff implemented on `main`; production acceptance of live quota classification remains an explicit validation gate.

Implemented runtime slices include schema validation, manifest freeze hashing, authorization binding, instruction trust policy, environment preflight, event replay, dependency snapshots, fake engine/gates, compile/status, deterministic fake runs, dynamically discovered Claude/Codex CLIs with behavioral compatibility checks, single-writer real-engine runs, worker-owned Git commits, real quality gates, read-only review coverage, terminal reports, bounded per-task `ai-code-control` context, and minimum local recovery checkpoints.

See `docs/PHASE-1.md` for the current MVP milestone ledger and validation commands.
