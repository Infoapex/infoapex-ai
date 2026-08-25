# ADR-0005 — Worker compatibility matrix and pin policy

- **Status:** `accepted` — 2026-08-16
- **Date:** 2026-08-16
- **Relates to:** ADR-0001 (`docs/adr/0001-per-task-routing-contract.md`), decision 14 of `_FINAL.md` §2 (consumer project planning repository)

## Context

`ai-code-planner` interoperates with `ai-code-worker` exclusively through versioned JSON schema and CLI-JSON — never by code import. This means planner's correctness depends on which shape of `manifest.schema.json` and `project-config.schema.json` it targets.

The consumer project integration established a concrete pin: commit **`d23d5a0`** of `ai-code-worker`. Decision 14 of `_FINAL.md` §2 records this pin as the minimum supported version and states that it must not be silently moved. `ai-code-worker`'s `origin/main` branch is a candidate for future advancement of that pin, not an automatic upgrade target.

As of **2026-08-16**, the `ai-code-worker` repository used for dogfooding in this same consumer project session is a standalone HEAD clone that has moved past `d23d5a0`. The most recent commit in that clone is **`a6036ea`**, which includes cross-engine review and the `--fallback-engine` flag. This ADR does not resolve whether `a6036ea` or any later commit on `origin/main` becomes the new pin. It only states the review process that must precede any such change, consistent with decision 14 not being re-opened here.

Neither `d23d5a0` nor the current `origin/main` carries the `executionProfile` field in the task object of `manifest.schema.json`. That field is the subject of ADR-0001's contract extension and will not exist in worker until that extension lands, which is deferred to Phase 1 or later.

## Decision

**The minimum supported `ai-code-worker` version is commit `d23d5a0`** (the consumer project integration pin). Planner targets the schema shape as it exists at that commit.

**`origin/main` of `ai-code-worker` is a candidate for the pin to move to, never an automatic upgrade.** Moving the pin requires an explicit compatibility review covering at minimum:

1. All fields that planner reads from or writes to `manifest.schema.json` and `project-config.schema.json`, checked for additive vs. breaking change.
2. Any new required fields in the task object that planner does not yet emit.
3. Any narrowing of `schemaVersion` constraints (e.g. adding a new `const` that excludes `"1.0"`).
4. Any change to `additionalProperties` rules that would reject fields planner currently emits.

**Until a pin-advancement review has been completed and recorded**, planner's own contract tests — once they exist, starting Phase 1 — must cover **both** the pinned commit's `manifest.schema.json` shape and the current candidate's shape. The goal is to catch real schema drift before it is assumed away, not to block progress on the candidate.

## Compatibility table (as of 2026-08-16)

| Field | Minimum (`d23d5a0`) | Candidate (current `origin/main`) | Compatible? |
|---|---|---|---|
| `schemaVersion` (manifest.schema.json) | `"1.0"` (const) | `"1.0"` (const) | Yes |
| `executionProfile` in task object | absent | absent (pending ADR-0001 extension landing in worker) | Yes — drift expected in Phase 1+ |
| `testedVersionRanges` in `project-config.schema.json` (`adapters.codex` / `adapters.claude`) | present | present | Yes |

The table must be extended whenever a pin-advancement review is initiated. Each row that changes compatibility status to **No** is a blocking item for the review.

## Consequences

**What this clarifies.** Any Phase 1 contract test suite can be written with confidence that `d23d5a0` is the stable target and that `origin/main` drift is monitored explicitly, not ignored.

**What this defers.** The question of whether `a6036ea` (or a later `origin/main` commit) becomes the new pin is explicitly deferred. No Phase 0 deliverable depends on resolving it.

**What this costs.** Phase 1 test tooling must snapshot or fixture two versions of `manifest.schema.json` — the pinned shape and the candidate shape — and validate planner output against both. This is a small investment to avoid silent incompatibility across the tool family.

**Versioning.** The pin is identified by commit SHA, not by a semver tag, because `ai-code-worker` does not yet publish versioned releases. If the worker adopts semver releases before the next pin-advancement review, the review document must record both the SHA and the tag.

## Alternatives rejected

**Treat `origin/main` as the live target with no explicit pin.** Rejected: planner would silently break whenever worker's schema changes in a way that is not backward-compatible. The consumer project session already demonstrated that `manifest.schema.json` uses `"additionalProperties": false`, so any new required field or removed optional field is a breaking change that would not be caught at plan-generation time.

**Pin to a semver range rather than a commit.** Rejected: `ai-code-worker` has no published semver at this time. Committing to an imagined versioning scheme before it exists creates false confidence. SHA pins are unambiguous and cost nothing to record.

**Resolve the `a6036ea` → pin question inside this ADR.** Rejected: doing so would require performing the compatibility review as part of Phase 0, which is out of scope. Phase 0 produces contracts and decisions; the review is a Phase 1 activity that requires contract tests to exist before they can be run.
