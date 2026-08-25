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
