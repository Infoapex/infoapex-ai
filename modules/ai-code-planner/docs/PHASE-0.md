# Phase 0 — contracts and decisions

**No runtime.** Phase 0 produces documents, schemas, and fixtures only. Nothing in this phase invokes an LLM or writes source code.

This is deliberate: Phase 0 deliverables are documentation, which is the one workload class `ai-code-worker` has already been proven on (confirmation pilot, 3 of 3 `DONE`, no scope or gate bypass). Phase 0 can therefore be executed by worker as it exists today, at the pinned commit, with no modification.

## Exit gate

Every material decision is either **accepted** or explicitly marked `proposed`. No decision is silently assumed.

## Deliverables

### ADRs

- [x] `adr/0001-per-task-routing-contract.md` — reformulates decision 4 of the Infoapex AI vision *(status: accepted, 2026-08-15)*
- [x] `adr/0002-plan-and-manifest-ownership.md` — planner emits the plan; worker compiles, validates, freezes *(status: accepted, 2026-08-16)*
- [x] `adr/0003-fallback-ownership.md` — planner proposes, worker verifies, freezes, and executes; never used to mask a policy failure, scope violation, or deterministic test failure *(status: accepted, 2026-08-16)*
- [x] `adr/0004-agent-runner.md` — planner uses its own adapters; the model-identity and usage schemas stay shared with worker *(status: accepted, 2026-08-15, formalized 2026-08-16)*
- [x] `adr/0005-worker-compatibility-matrix.md` — minimum supported version (`d23d5a0`), current candidate, upgrade and blocking rules *(status: accepted, 2026-08-16)*

### Public schemas

- [x] `schemas/plan.schema.json` — planner's rich internal plan
- [x] `schemas/finding.schema.json` — structured findings, shared by the linter and (later) the review panel
- [x] `schemas/planning-provenance.schema.json` — who planned this, with what topology, how many rounds, what cost
- [x] `schemas/execution-profile.schema.json` — logical profile and its resolved snapshot

### Linter contract

- [x] the deterministic checks, each with its failure mode and message — `docs/LINTER-CONTRACT.md`
- [x] the projection rule from the rich plan to the worker v1.0 export, and how information loss is reported — `docs/LINTER-CONTRACT.md` § Projection to worker v1.0

### Fixtures

- [x] at least one valid manifest against the schema at `d23d5a0` — `fixtures/valid/worker-v1.manifest.json`
- [x] at least one invalid manifest per linter rule — `fixtures/invalid/` (7 fixtures + index README)

**Phase 0 exit gate met 2026-08-16.** All deliverables produced via `ai-code-worker` dogfooding
(`Plan/PHASE-0-REMAINDER.md`, 9 tasks, real Claude engine, deterministic gate-verified —
see `scripts/verify/*.mjs` and `.ai-code-worker/quality-gates.json`). No decision in this
document is silently assumed; every ADR is `accepted`.

## Explicitly out of scope for Phase 0

- any LLM invocation
- the routing implementation
- the consensus panel runtime
- `reasoningEffort`

## Reference

The full design record, including phasing, value gates, and the reasoning behind each decision, lives in the consumer project planning repository under `Plan/Architect/_FINAL.md`. Documents dated before 2026-08-15 use the earlier product name *ai-code-architect*.
