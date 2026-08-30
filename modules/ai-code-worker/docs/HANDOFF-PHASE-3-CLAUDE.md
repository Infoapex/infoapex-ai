# Handoff for Claude: Phase 3 implementation

Date: 2026-08-14
Repository: `Infoapex/ai-code-worker`
Current branch: `main`
Merged PR: `historical integration handoff`
Merge commit: `a1062eb810d6b05650f9a33f996aeb0488e6d808`

## Current state

Phase 0, Phase 1, and the limited Phase 2 scope are merged to `main`.

Phase 2 delivered:

- Claude Code headless adapter and `doctor --engine claude`.
- `run --engine claude`.
- DAG scheduling primitives and overlap guards.
- Deterministic integration helpers and conflict reports.
- Sync-root enforcement before parallel dispatch.
- Post-dogfooding hardening items from `todo.md`.
- Hardened JSON extraction for Claude/Codex-style final messages that include prose or stray braces before the valid result object.

Latest validations before merge:

```powershell
npm test
npm run phase0:demo
npm run phase2:demo
```

Observed result: all passed. The `npm test` run passed 159 tests and JSON schema validation over 32 JSON files.

## Important context

Read these files first:

- `docs/IMPLEMENTATION-PLAN.md`
- `docs/PHASE-0.md`
- `docs/PHASE-1.md`
- `docs/PHASE-2.md`
- `docs/adr/0001-scope-hook-interoperability.md`
- `docs/adr/0002-execution-environments.md`
- `docs/adr/0003-instruction-trust-and-run-authorization.md`
- `docs/adr/0004-dependency-snapshots-and-graph-revisions.md`
- `docs/adr/0005-streaming-engine-adapter.md`
- `docs/adr/0006-minimum-recovery-before-pilot.md`
- `docs/adr/0007-claude-adapter-and-dag-scheduler.md`
- `todo.md`

Do not re-open the five post-dogfooding items from `todo.md`; they are closed and merged.

## Next implementation target: Phase 3

Phase 3 is defined in `docs/IMPLEMENTATION-PLAN.md` as:

- review findings and repair task compiler;
- maximum repair cycles and repeated-failure detection;
- graph revisions, `SUPERSEDED` runs, and descendant invalidation;
- recovery for remote backends and multi-host scenarios;
- export patch, branch, and report;
- security/redaction tests.

Exit criterion:

Blocking findings must generate bounded repair attempts, graph revisions must not mutate the frozen manifest, and advanced recovery scenarios must preserve the Phase 1 safety properties.

## Recommended sequencing

1. Add the data model and schemas for review findings, repair tasks, repair attempts, repair budgets, repeated-failure signatures, graph revisions, and superseded runs.
2. Implement deterministic review finding ingestion using fake/local review fixtures first. Do not rely on model judgment as proof of correctness.
3. Add a repair task compiler that converts blocking findings into scoped tasks with explicit allowed paths, verification commands, dependencies, and budget limits.
4. Wire bounded repair cycles into the run state machine. Enforce `maximumRepairCycles` and stop early when the same failure signature repeats without progress.
5. Implement graph revision semantics: a new graph revision can supersede a run, but must not mutate the original frozen manifest or authorization binding.
6. Invalidate descendants deterministically when dependency outputs change during repair or replanning.
7. Add recovery tests for process kill during review, repair compilation, repair execution, and integration.
8. Add export commands or reports for patch, branch, final report, blocked report, and repair evidence.
9. Expand security/redaction tests for findings, repair prompts, run reports, exported artifacts, event logs, and oversized output.
10. Only after deterministic fake coverage is green, exercise the path with real Codex/Claude adapters.

## Guardrails

- The coordinator owns commits. Models must not run `git commit`, `git push`, `git reset`, or `git clean`.
- A repair task cannot expand scope unless a new authorized graph revision explicitly allows it.
- The frozen manifest remains immutable. Replanning creates a new revision/run relationship, not an in-place edit.
- A failed repair loop must return `BLOCKED` with cause, last safe state, evidence, and resume instructions.
- Redacted reports are allowed in the repository only when explicitly exported.
- Raw transcripts, secrets, and unredacted engine output must not be persisted in repo artifacts.
- Preserve support for `contextProvider: "none"`; `ai-code-control` integration belongs to Phase 4.

## Commands to run before starting

```powershell
git switch main
git pull --ff-only origin main
npm ci
npm test
npm run phase0:demo
npm run phase2:demo
```

## Commands expected before handoff

At minimum:

```powershell
npm test
npm run phase0:demo
npm run phase2:demo
```

Add focused tests for every Phase 3 feature implemented. If real Codex/Claude runs are used, document the exact command, engine versions from `doctor`, and whether any model subscription/API setup was required.

## Known non-goals for Phase 3

- Do not implement the Phase 4 `ai-code-control` provider.
- Do not decide the stable distribution channel.
- Do not introduce SDK-based adapters unless the CLI adapter path is blocked.
- Do not claim release readiness until the extended value gate receives `PASS`.

## Current product status

The extended consumer-project value gate remains a product validation gate before stable release claims. It is separate from Phase 3 engineering work and is currently documented as paused/conditional on consumer-project review availability.

Phase 3 can begin now on `main`.
