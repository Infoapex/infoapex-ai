# ADR-0002 — Plan and manifest ownership

- **Status:** `accepted` — 2026-08-16
- **Date:** 2026-08-16

## Context

Two tools touch the plan before `ai-code-worker` begins executing: `ai-code-planner` produces a reviewable plan document, and `ai-code-worker` compiles that document into the frozen manifest it will run from. Without an explicit ownership boundary, it is unclear which tool is responsible for which fields, and whether planner is ever permitted to produce a complete manifest directly.

The question is sharpened by the fact that planner's internal plan representation is richer than the worker v1.0 export. Planner tracks criterion IDs, gate IDs, and typed evidence contracts that do not appear in `schemas/manifest.schema.json`. A projection step reduces that rich representation to the worker-compatible subset. Where that projection happens, and who performs it, is part of the ownership boundary this ADR establishes.

The projection mechanics — the exact rules, information-loss reporting, and linter contract — belong to the linter contract document, not here. This ADR records only the ownership boundary itself.

## Decision

**Planner is read-only with respect to the manifest.** It never produces the frozen manifest.

Planner emits `Plan/<task>.md`: a Markdown file with `status: accepted` frontmatter and a fenced `ai-code-worker-plan` JSON block containing planner's accepted plan output. This file is intended for human review before execution.

**Worker owns manifest compilation and freezing.** After a plan is accepted, worker:

1. reads `Plan/<task>.md`;
2. projects the plan content to the worker v1.0 export format (see the linter contract document and `schemas/plan.schema.json` for projection rules);
3. validates the result against `schemas/manifest.schema.json`;
4. assigns the fields that only it can assign, because it owns them at compile time:
   - `runId` — assigned by worker at the start of each run;
   - `graphVersion` — assigned by worker when the task graph is compiled;
   - `plan.sha256` — the hash of the accepted plan content, computed at freeze time;
   - `base.commit` — the HEAD commit of the repository at the moment worker begins, not the moment planner ran.
5. writes the frozen manifest.

These four fields are **worker-only**. Planner must not emit them, and the manifest schema validator must reject any manifest submitted to worker that pre-populates them.

Planner's own internal plan representation (criterion IDs, gate IDs, typed evidence contracts) is richer than the worker v1.0 export. The projection step that reduces it to the worker-compatible subset is defined by the linter contract document and formalised in `schemas/plan.schema.json`. Cross-reference: the projection mechanics are out of scope for this ADR; the schema for the rich representation is out of scope for `schemas/manifest.schema.json`.

## Consequences

**What changes for planner.** Planner is responsible for producing a valid, human-readable `Plan/<task>.md`. It is not responsible for, and must not attempt to produce, `runId`, `graphVersion`, `plan.sha256`, or `base.commit`. Planner's output format remains stable regardless of future changes to the worker manifest schema, as long as the projection rules in the linter contract document are updated accordingly.

**What changes for worker.** Worker gains a compile step: it reads `Plan/<task>.md`, projects it, validates it, assigns the four compile-time fields, and freezes the manifest. This is an internal worker change with no external interface impact beyond the manifest schema.

**This ADR does not change ai-code-worker.** No code or schema in the `ai-code-worker` repository is touched by this decision. The compile step described above is a future implementation; it does not exist yet and is not required for Phase 0. Phase 0 produces documents only.

**Auditability.** Because `plan.sha256` is computed by worker at freeze time from the accepted plan content, any modification to `Plan/<task>.md` after worker ran is detectable. The accepted plan and the frozen manifest are permanently linked.
