# ADR-0001 — Per-task routing requires a worker contract extension

- **Status:** `accepted` — 2026-08-15
- **Date:** 2026-08-15
- **Supersedes:** decision 4 of `AI-CODE-APEX-VISION.md` (in the `ai-code-worker` repository, `docs/AI-CODE-APEX-VISION.md`, dated 2026-08-15)

## Context

`AI-CODE-APEX-VISION.md` records two decisions that cannot both hold:

- **Decision 2:** *ai-code-architect (now ai-code-planner) picks the LLM model per task.*
- **Decision 4:** *The worker does not change at all for this.*

Verified against `ai-code-worker` at commit `d23d5a0` (the version pinned by the consumer project integration) and at `5ea3e2d` (`origin/main`):

- `schemas/manifest.schema.json` declares `"additionalProperties": false` on the task object, and the task carries no `engine`, `model`, or `effort` field;
- the engine is selected per run (`--engine`), the model per adapter (`adapters.codex.model`, `adapters.claude.model`);
- `budgets` are run-level, not per task.

Per-task routing is therefore not expressible in the current contract. This is a schema limit, not an implementation gap.

## Decision

**Decision 4 is reformulated.** What stays stable is the *plan format* — `Plan/<task>.md` with `status: accepted` frontmatter and the fenced ` ```ai-code-worker-plan ` JSON block — and the principle that tools interoperate by file and CLI-JSON, never by code import.

The manifest schema gains an **optional, backward-compatible** routing field. Manifests without it keep working and mean "use the run-level engine", which is exactly today's behaviour.

The field is a **logical profile**, not raw values:

```json
{ "executionProfile": "backend-balanced-v1" }
```

Worker resolves the profile at compile time into a frozen snapshot recording `engine`, `resolvedModel`, `fallbacks`, `reason`, `confidence`, and `policyVersion`. Concrete model identifiers never appear in business plans; they are resolved from versioned policy and confirmed by `doctor`.

## Consequences

**What is unblocked.** Planner can assign a cheap model to mechanical work and a capable model to contracts, migrations, and review — the reason the product exists.

**What was never blocked.** Planner can be built and produce useful plans today, without this change. Worker executes v1.0 plans right now: `doctor` is green on both engines and the confirmation pilot returned `PASS` on 3 of 3 tasks. Phases 0 and 1 require no worker modification. Earlier revisions of the design document claimed nothing could start before this decision; that was wrong.

**What this costs.** Worker's scheduler must bind an engine per task rather than per run. `src/run/codex-run.ts` and `src/run/claude-run.ts` are separate entry points today, so the real work is a per-task adapter dispatch. Per-task *model* is small once per-task *engine* exists. Per-task *effort* is deliberately excluded — neither `adapters.claude` nor `adapters.codex` exposes any effort field, so it needs schema plus passthrough through two CLIs with different semantics plus `doctor` validation. It is deferred until benchmarks show it adds value over model selection alone.

**Versioning.** `schemaVersion` should accept `"1.1"` alongside `"1.0"` rather than silently widening `"1.0"`. The consumer project pin `d23d5a0` remains the minimum supported version; contract tests must cover both it and the current candidate, and the pin moves only after an explicit compatibility review.

## Alternatives rejected

**Sidecar routing file, worker unchanged.** Planner emits routing beside the manifest. Rejected: nothing consumes it. Worker runs one engine per run, so a sidecar would require running worker once per engine group — losing cross-engine parallelism within a wave and producing several run reports and integration branches for one plan.

**Engine-partitioned runs.** Planner emits one manifest per engine, chained by dependency. Worker unchanged, but the same loss of parallelism plus manual cross-run dependency management.

**Holding decision 4 as absolute.** Planner becomes a plan generator with no routing — it still adds scope enforcement, deterministic linting, and reviewable plans, but not cost optimisation, which is its primary purpose.
