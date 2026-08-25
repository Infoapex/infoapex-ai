# ADR-0004 — Agent runner: planner uses its own adapters; model-identity and usage schemas stay shared

- **Status:** `accepted` — 2026-08-15
- **Date:** 2026-08-15

## Context

`ai-code-planner` must invoke LLMs directly — for intake, classification, decomposition, and routing proposals. Three approaches were considered:

**Option A — Shared/extracted runtime consumed via CLI-JSON.** Extract the adapter layer from `ai-code-worker` into a standalone package; planner consumes it via CLI-JSON, never by direct import, and both tools stay on the same version.

**Option B — Worker-side plan-only mode.** Add a `--plan-only` flag (or equivalent) to `ai-code-worker` so that planner delegates all LLM calls back to the worker, which already has working adapters for Codex and Claude.

**Option C — Planner's own adapters.** Planner implements its own adapter layer independently. Code may be copied from worker for similar mechanics; worker's TypeScript modules are never imported.

`ai-code-worker` is pinned at commit `d23d5a0` for the consumer project integration. Options A and B both require a coordinated change to the worker before planner can start: extracting a shared package for a single consumer (planner) would serialize the entire project behind a refactor of a live tool. An interface should not be extracted until at least two independent consumers exist. Option B adds a new execution mode to worker with no benefit to worker itself.

**Option C was chosen.** It unblocks planner immediately without touching worker, and the only real cost — duplicated adapter mechanics — is acceptable: copying code for similar mechanics is a standard practice where the alternative is premature coupling.

## Decision

Planner implements its own adapter layer. The boundary is:

- **Permitted:** copying code from `ai-code-worker` for similar mechanics — process spawn, timeout, output caps, retry logic.
- **Forbidden:** importing `ai-code-worker`'s TypeScript modules at runtime, directly or transitively.

Interoperability between the two tools is by versioned JSON schema and CLI-JSON only, as stated in `README.md`.

**The mandatory shared part.** Even though adapters are independently implemented, planner **must** use the same versioned schemas as worker for:

- **Resolved model identity** — the frozen snapshot produced after `executionProfile` resolution (schema: `schemas/execution-profile.schema.json`).
- **Usage recording** — token counts and cost figures that flow into `planningProvenance` (`schemas/planning-provenance.schema.json`) and into the per-task routing outcome.

These numbers must be comparable across tools. `planningProvenance` (§7.10 of the design record) and the routing-outcome record (decision 13 of §2 of the design record) are only meaningful if planner and worker use identical field names, units, and version identifiers. Independent adapters are fine; independent schemas for the same quantities are not.

## Consequences

**This ADR does not change `ai-code-worker`.** The pinned commit `d23d5a0` remains the minimum supported version. No worker modification is gated on or implied by this decision.

**Planner is unblocked immediately.** It can implement its adapter layer in Phase 1 without waiting for any worker refactor.

**Schema ownership is explicit.** `schemas/execution-profile.schema.json` and `schemas/planning-provenance.schema.json` are owned by this repository (`ai-code-planner`). Worker must consume compatible versions of these schemas for routing-outcome and provenance records to be meaningful. The compatibility requirement is stated here and enforced by the worker compatibility matrix (ADR-0005).

**Duplication is bounded.** Only the mechanical adapter layer (process lifecycle, timeouts, output caps) is duplicated. Business logic — routing policy, profile resolution, linting rules — is not in worker and therefore cannot be duplicated from it.

## Alternatives rejected

**Option A — Shared/extracted runtime.** Extracting a package for a single consumer would require a coordinated refactor of a live, pinned tool before planner can start. An interface is not worth extracting for one consumer.

**Option B — Worker-side plan-only mode.** Adding a planning mode to worker conflates execution and planning responsibilities. It would also make planner's behaviour dependent on worker's release cadence, which is the coupling this decision explicitly avoids.
