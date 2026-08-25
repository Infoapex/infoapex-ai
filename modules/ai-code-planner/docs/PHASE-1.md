# Phase 1 — propose / inspect / compile / explain-routing, decomposer, linter runtime, worker v1.0 export

**Built 2026-08-16**, via `ai-code-worker` dogfooding (`Plan/PHASE-1.md`, since trimmed down
task by task as each one merged — see `git log` for the individual task commits and merges).
Claude-only, no independent review, at the user's explicit direction to conserve weekly usage.

## Verified planner-worker flow

- Standalone: planner `compile` -> worker `compile` -> worker `run --engine fake`, with one task completed and its gate passing.
- Integrated: `infoapex-ai init --mode integrated` -> planner publishes `planner-to-worker.json` -> worker publishes `worker-to-planner.json` -> planner `ingest-worker-report` returns `DONE`.
- Continuation: a `BLOCKED` worker handoff is consumed by planner `replan`, which writes a new draft with the replacement logical profile and provenance.

## What exists

| Module | Purpose |
|---|---|
| `src/types.ts` | TypeScript types mirroring `schemas/plan.schema.json`, `finding.schema.json`, plus the worker v1.0 export shape |
| `src/schema-validate.ts` | ajv-based validation against any `schemas/*.schema.json` file |
| `src/linter/lint-plan.ts` | Deterministic linter implementing every check in `docs/LINTER-CONTRACT.md` |
| `src/projection/project-to-worker-v1.ts` | Projects the rich plan schema to the worker v1.0 shape, with explicit `projectionWarnings` for lossy fields |
| `src/plan-file/{write,read}-plan-markdown.ts` | Writes/reads `Plan/<id>.md` in the exact format `ai-code-worker`'s own `compile` consumes |
| `src/engine/claude-adapter.ts` | Planner-owned Claude CLI adapter (mechanics copied from `ai-code-worker`'s `ClaudeCliAdapter` per ADR-0004, not imported) |
| `src/decompose/decompose-prompt.ts` | Single-shot (`fanout=false`) decomposer: prompt → rich `Plan`, one retry on schema-invalid output |
| `src/cli.ts` | Wires `propose`/`inspect`/`compile`/`explain-routing` together |

27 unit tests (`npm test`), all real `node:test` assertions, no `node -e` heuristics.

## Real bugs found and fixed along the way (all mechanical, all fixed directly rather than via a repair cycle, to conserve the user's remaining weekly Claude usage)

1. **ajv/ajv-formats default-import interop under `moduleResolution: NodeNext`.** ajv's `.d.ts` has a usable named export (`Ajv2020`) that sidesteps the problem; ajv-formats does not (its `.d.ts` is authored in ESM `export default` syntax despite being a CJS package with no `"type"` field — a real upstream typing mismatch). Fixed with an explicit type assertion on the imported binding itself. See `src/schema-validate.ts` and the commit that fixed it for the full diagnosis.
2. **`spawnSync` with `shell:false` cannot resolve npm's `.cmd` wrapper on Windows** (confirmed directly: `ENOENT`). All of this plan's `verify` gates invoke `node` directly (`node node_modules/typescript/bin/tsc ...`, `node --test ...`) rather than `npm run build`/`npm test`, as configured gate ids in `.ai-code-worker/quality-gates.json` with `linkedDirectories` symlinking the real `node_modules` into each isolated task worktree.
3. **`spawnSync` with `shell:false` cannot invoke a `.cmd`/`.bat` executable directly either** (fails `EINVAL`, a different error than #2's `ENOENT`). Surfaced by `tests/unit/cli.test.ts`'s `propose` test, which points `--claude-executable` at a directly-executable fake CLI (a `.cmd` on Windows, matching how a real npm-global-installed CLI shim looks). Fixed in `src/engine/claude-adapter.ts` with the same `needsShellWrapper()` pattern already proven in `ai-code-worker`'s `src/engines/spawn-shell.ts`.

## What is explicitly NOT done

The planner runtime implementation described above is complete. Remaining items are operational gates: three real consumer project plans have not been consumed in this batch, and live mid-task quota failover remains dependent on a reliable CLI signal.

- **The actual Phase 1 exit gate from `Plan/Architect/_FINAL.md` §3**: *"3 planuri consumer project reale trec linterul și rulează pe worker-ul existent"* (3 real consumer project plans pass the linter and run on the existing worker). The mechanism to do this exists (`propose` → `inspect`/`compile` → `ai-code-worker run`), but it has not been exercised against 3 real consumer project task prompts end-to-end. This is real, uncompleted work, not a formality — do it before treating Phase 1 as "done" in the product sense, not just "the code compiles and its own tests pass" sense.
- `explain-routing` is deliberately a stub per Phase 1's own scope ("no routing") — it reports `executionProfile` as declared-but-unresolved and never invents a resolved engine/model. Phase 3 implements actual resolution.
- No independent review / repair cycle was used for this build (see above) — every task's correctness rests on its own deterministic `verify` gate (real build + real tests), the same strength of gate that worked cleanly for all of Phase 0.
