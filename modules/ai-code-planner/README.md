# ai-code-planner

## Current implementation status

Planner v1 is implemented and verified for the planner-worker contract. It includes optional `ai-code-control` context, deterministic logical routing, worker-export validation, opt-in Infoapex AI handoff, worker feedback ingestion, and deterministic `replan` after an incomplete run. A synthetic planner -> worker run and an integrated bidirectional handoff both pass.

Live production acceptance with real Claude/Codex quota signals and the separate three-plan consumer project value gate remain operational validation, not missing planner code.

Turns a task prompt into a **scoped, linted, routed implementation plan** that `ai-code-worker` executes.

> **Status: Phase 1 mechanically complete, optional Infoapex AI handoff implemented, value gate not yet demonstrated.** `propose`/`inspect`/`compile`/`explain-routing`/`ingest-worker-report` exist and are exercised by tests, including projection to the worker manifest and opt-in planner-to-worker handoff. What has NOT been demonstrated: `_FINAL.md`'s actual Phase 1 exit gate — "3 real consumer project plans pass the linter and run on the existing worker." See `docs/PHASE-1.md`.

## What it does

```
prompt
  → intake            goal, non-goals, acceptance criteria, ambiguities
  → context           optional, via ai-code-control (degrades if absent)
  → classification    multidimensional scores + confidence
  → decomposition     task DAG with dependencies, scope, gates
  → deterministic lint
  → routing proposal  which engine and model each task should use
  → Plan/<task>.md    reviewed and accepted by a human
                      ↓
                   ai-code-worker compiles, freezes, executes
```

## What it does not do

- **It does not write code.** It plans; `ai-code-worker` implements.
- **It does not produce the final frozen manifest.** It emits `Plan/<task>.md` with an `ai-code-worker-plan` block; worker adds the run metadata, hashes the plan, and freezes it.
- **It does not design your system architecture.** It decomposes and routes a task you already decided to do. (This is why it is named *planner*, not *architect*.)

## Why it exists

Today a coding agent session uses one model for everything — the same expensive model updates a README and writes a database migration. Planner assigns each subtask the cheapest model that can do it correctly, and reserves capable models for contracts, migrations, and review.

The gain is not "spend less". It is **being able to afford the capable model exactly where it matters**, because it was not burned on trivia.

## Independence

`infoapex-ai init --mode integrated` enables the optional planner <-> worker handoff. Without that flag, both modules remain independent. The planner assigns logical profiles such as `mechanical-fast-v1` and `balanced-default-v1`; worker resolves and freezes concrete engine/model values from the repository routing policy.

Each tool in the family runs standalone. `ai-code-planner` may *optionally consume* `ai-code-control` for context and `ai-code-worker`'s plan format for output, but requires neither to function — missing neighbours reduce context richness and confidence, they do not stop it.

Interoperability is by **versioned JSON schema and CLI-JSON only** — never by importing another tool's internal modules. Copying code for similar mechanics is fine; depending on it is not.

## Family

| Tool | Role |
|---|---|
| **ai-code-planner** | plans a task, routes each subtask to a model |
| `ai-code-worker` | executes the plan, owns gates and evidence |
| `ai-code-control` | indexes the code, owns memory and scope |
| `ai-code-review` | milestone-level audit |
| `ai-code-docs` | final documentation |

`infoapex-ai` is the thin umbrella that installs them together. Components never depend on the umbrella.

## Design record

The full architecture — decisions, phasing, value gates, and the reasoning behind them — lives in the consumer project planning repository under `Plan/Architect/`, consolidated in `_FINAL.md`. Documents written before 2026-08-15 use the earlier name *ai-code-architect* and refer to this same product.

## License

Proprietary. Copyright (c) Infoapex.
