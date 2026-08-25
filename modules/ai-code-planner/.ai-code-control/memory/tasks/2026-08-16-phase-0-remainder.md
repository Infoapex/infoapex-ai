# Task - 2026-08-16 - Phase 0 remainder

## Goal

Close out every remaining Phase 0 deliverable listed in `docs/PHASE-0.md`: the 4
remaining ADRs (0002-0005), the 3 remaining public schemas (`plan`,
`planning-provenance`, `execution-profile`), the deterministic linter contract
document, and fixtures (1 valid + N invalid worker v1.0 manifests). Phase 0's exit
gate is "every material decision is either accepted or explicitly marked proposed" -
this closes that gate.

## Context used

- `Plan/Architect/_FINAL.md` (rev. 5) in the consumer project planning repository - every
  task implemented a decision already recorded there (§2, §3, §7.10, decision 3 of
  §2, decision 13 of §7bis), not a new product decision.
- `docs/adr/0001-per-task-routing-contract.md` as the section-structure template for
  the 4 new ADRs.
- `docs/PHASE-0.md` as the deliverable checklist.
- `schemas/finding.schema.json` (already existing) as the JSON-Schema style template.

## Changed files

- docs/adr/0002-plan-and-manifest-ownership.md (added)
- docs/adr/0003-fallback-ownership.md (added)
- docs/adr/0004-agent-runner.md (added)
- docs/adr/0005-worker-compatibility-matrix.md (added)
- schemas/plan.schema.json (added)
- schemas/planning-provenance.schema.json (added)
- schemas/execution-profile.schema.json (added)
- docs/LINTER-CONTRACT.md (added)
- fixtures/valid/worker-v1.manifest.json (added)
- fixtures/invalid/*.json + fixtures/invalid/README.md (added, 7 fixtures)
- docs/PHASE-0.md (checklist updated, all items checked, exit gate marked met)
- .ai-code-worker/quality-gates.json (9 new gate ids)
- scripts/verify/*.mjs (9 new verify scripts)
- docs/IMPLEMENTATION-TOKEN-ESTIMATE.md (added - local copy of the plan + token
  estimate document, per the "plans stay local, never published online" rule)
- todo.md (added - tracks the ai-code-control wiring gap found and then fixed in a
  follow-up task, see Open issues)

## Changes made

Second real dogfooding run of `ai-code-worker` against this repo (first was
`FINDING-SCHEMA-001`, a single task). This time a 9-task DAG plan
(`Plan/PHASE-0-REMAINDER.md`): 6 independent tasks (4 ADRs + 2 of the 3 schemas)
plus `SCHEMA-PLAN` (also independent), then `LINTER-CONTRACT` (depends on
`SCHEMA-PLAN`) and `FIXTURES` (depends on `LINTER-CONTRACT` + `SCHEMA-PLAN`).

Real bug found and fixed en route: `ai-code-worker`'s `resolveQualityGate()` rejects
any raw `verify` command string containing `;`, `&`, `|`, `<`, `>`, or a backtick -
even inside quotes - as unsafe. The plan's first draft used inline `node -e "..."`
one-liners with semicolons and regex alternation (`|`), which tripped this filter
before any engine was even invoked (cheap to catch, no tokens spent). Fixed by
writing real verify scripts (`scripts/verify/*.mjs`) and registering them as
configured gate ids in `.ai-code-worker/quality-gates.json` - the trusted path that
bypasses the raw-string safety filter by design, matching the same
"prefer structured/allowlisted verification over ad-hoc shell" principle this
plan's own linter contract and `_FINAL.md`'s consensus-panel verification broker
describe.

Second bug found and fixed: `scripts/verify/schema-plan.mjs` initially checked
`schema.properties.tasks.items.required` directly, but Claude's actual
`schemas/plan.schema.json` correctly used `items: {"$ref": "#/$defs/task"}` instead
of inlining the task object - a better schema design than the verify script
assumed. Fixed by resolving one level of `$defs` `$ref` before reading `.required`.

Real engine-availability incident during the run (not simulated): the `claude`
engine hit a real session rate limit (HTTP 429, "session limit resets 3:20am") mid
run, after 4 tasks had already committed successfully. Switched to `--engine codex`
manually, which then hit a different real failure (codex's sandbox rejected writes
as read-only). At the user's explicit direction ("nu vom folosim codex deloc"),
switched back to `claude` with a fresh `--run-id` (compile is deterministic on
plan-hash + base-commit, so re-running with unchanged inputs replays the persisted
blocked state instead of re-executing - a real idempotency behavior, not a bug,
worth remembering for future retries) and it completed cleanly: 9/9 tasks `DONE`,
zero findings.

All 9 task commits were real, disjoint-path commits off the same or a
dependency-integrated base commit. Merged into `main` via 9 sequential
`git merge --no-ff` calls (SCHEMA-PLAN, then LINTER-CONTRACT, then FIXTURES in
that order since they chain; the other 6 in any order since they touch disjoint
paths) - all clean, zero conflicts. Re-ran every verify script against the merged
tree afterward to confirm the merge didn't silently break anything.

## Validation

- All 9 `scripts/verify/*.mjs` gates: PASS (re-verified manually against merged
  `main`, not just inside each task's isolated worktree).
- `node scripts/validate-json.mjs`: 16 JSON files valid.
- `ai-code-worker run` overall status: `DONE`, `findings: []`.

## Open issues

- `ai-code-control` indexing for this repo was not actually wired up at the time
  this task ran - `.mcp.json` referenced `tools/ai-code-control/mcp-server/dist/server.js`,
  which did not exist (no submodule ever added). Root-caused and fixed in the
  immediate follow-up task (see the next task summary, if one exists, or `git log`
  around this date for the submodule-add commit) by copying the exact working
  pattern from the consumer project repository (`ai-code-control` as a bundled module
  at `modules/ai-code-control`, `.mcp.json` pointing at the
  nested `ai-code-control/tools/ai-code-control/mcp-server/dist/server.js` path).
- `index-code` correctly finds 0 files in this repo today - Phase 0 has no runtime
  by design (`docs/PHASE-0.md`: "Phase 0 produces documents, schemas, and fixtures
  only"), and the indexer only covers C#/TypeScript/JavaScript/SQL source. This will
  start indexing real content once Phase 1 adds `src/**/*.ts`.
- The `memory-control.json` `include` list (`AGENTS.md`, `CLAUDE.md`,
  `REFACTOR_POLICY.md`, `.ai-code-control/memory/**/*.md`, plus report globs) does
  not cover `docs/adr/**` or `docs/*.md` - the new ADRs and `LINTER-CONTRACT.md` are
  NOT picked up by `memory-ingest` as-is. Not fixed here (out of scope for this
  task); worth deciding whether ADRs should be a first-class memory source before
  Phase 1 produces more of them.

## Next recommended task

Phase 1: `propose`/`inspect`/`compile`/`explain-routing` CLI commands, the
decomposer (`fanout=false`), the deterministic linter runtime (implementing the
contract this task just wrote), and the worker v1.0 export projection. Deferred at
the user's explicit request on 2026-08-16 due to remaining weekly usage budget
(~5%) - see `docs/IMPLEMENTATION-TOKEN-ESTIMATE.md` for the cost estimate (350k-550k
tokens, the single largest slice of the plan after the optional consensus panel).
