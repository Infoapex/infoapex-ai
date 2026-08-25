# Handoff: usage-benchmark tool + Phase 4 (and what's left in ai-code-worker)

Date: 2026-08-15
Repository: `Infoapex/ai-code-worker`
Current branch: `main`
Last pushed commit: `cc6e2ab` (Phase 3 complete + Codex validation, see `todo.md` items 1-10)

## Current state

Phase 3 (`docs/IMPLEMENTATION-PLAN.md`) is fully implemented, tested (220/220), and
pushed. Both real engines were validated end-to-end this session:

- `doctor --engine claude`: PASS, Claude Code CLI 2.1.177. Real `run --engine claude`
  on an isolated single-task fixture: DONE, real commit, real gate pass.
- `doctor --engine codex`: PASS via a project-config `testedVersionRanges` override
  (codex-cli 0.148.0-alpha.9 isn't in the hardcoded default list yet - see
  `todo.md` #10). Real `run --engine codex`: DONE, real commit, real gate pass. The
  `codex` binary is **not a global PATH install on this machine** - it ships bundled
  inside the VS Code `openai.chatgpt` extension
  (`<vscode-extensions>\openai.chatgpt-<version>-win32-x64\bin\windows-x86_64\codex.exe`).

Read `todo.md` in full before starting - items 1-10 document every deferred/found
issue from Phase 3, including two still explicitly open:

- **#9**: the real independent-review call (an actual Claude/Codex invocation that
  produces genuine review findings from a diff) was never built - only the mechanism
  around it (ingestion, repair compiler, bounded cycles, the injectable hook in all
  three runners). Comparable in scope to building `claude-run.ts`/`codex-run.ts` in
  the first place.
- **#10**: Codex was validated at smoke-test depth only, not the deeper behavioral
  verification (sandbox modes, auth modes) the two pinned entries in
  `src/doctor/doctor.ts`'s `testedVersionRanges` default carry.

## Part A: token/usage benchmark tool

### Goal (from the user)

A benchmark built into `ai-code-worker` itself (not just the Claude Code session that
develops it) that: checkpoints usage at the start and end of a task/run, keeps a
running history broken down by task/tool/method, and - before starting a new task -
estimates how many tokens it will cost, based on that history. The concrete target
is: "when we use ai-code-worker to implement a plan, estimate how many tokens it will
cost" - i.e. this is primarily about **ai-code-worker's own runtime engine
invocations** (Codex/Claude calls made while executing a plan), not about the
Claude Code session used to develop ai-code-worker (that's what
`docs/BENCHMARKS.md`, built during Phase 3, already does manually).

### Key findings from this session (verified, not assumed)

1. **Codex CLI writes a locally-readable rate-limit percentage, for free.**
   `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` contains `token_count` events shaped
   like:
   ```json
   {"type":"event_msg","payload":{"type":"token_count",
     "info":{"total_token_usage":{"input_tokens":...,"cached_input_tokens":...,"output_tokens":...,"total_tokens":...},
              "last_token_usage":{...},"model_context_window":258400},
     "rate_limits":{"primary":{"used_percent":86.0,"window_minutes":10080,"resets_at":1787202059},
                     "plan_type":"plus", ...}}}
   ```
   `total_token_usage` is already cumulative (no manual summing needed) and
   `rate_limits.primary.used_percent` is the direct equivalent of Claude's `/usage`
   percentage - fully automatable for Codex.

2. **Claude Code writes per-message token usage locally, but not an account-level
   percentage.** `~/.claude/projects/<project-hash>/<session-id>.jsonl` has one line
   per message; assistant messages carry `message.usage` with
   `input_tokens`/`cache_read_input_tokens`/`cache_creation_input_tokens`/`output_tokens`
   per turn. Verified: summing these is **not** meaningful directly (cache_read is
   reported per-turn as that turn's full prefix, so raw summation double-counts
   quadratically) - the useful derived values are (a) **current context size** ≈ the
   *last* message's `input_tokens + cache_read_input_tokens + cache_creation_input_tokens`
   (verified against a live `/context` reading - tracked within the expected growth
   trend), and (b) **billing-equivalent cost** = sum over turns of
   `output_tokens×1 + cache_creation_input_tokens×(1.25 or 2, by TTL) + cache_read_input_tokens×0.1 + input_tokens×1`,
   which is what actually accrues against `%5h`/`%weekly` but whose exact conversion
   constant is not published by Anthropic.
   **No account-level `%5h`/`%weekly` field exists in the local transcript** - `claude -p "/usage"` was tested live and does NOT intercept the slash command (it was sent to the model as literal text, costing ~$0.08 for that one test - don't repeat this test). The percentage remains readable only via the interactive `/usage` UI. Practical
   implication: token/context tracking for Claude can be fully automated from the
   local transcript; the `%5h`/`%weekly` conversion constant needs periodic manual
   calibration (occasional `/usage` spot-check), not a checkpoint-by-checkpoint one -
   `docs/BENCHMARKS.md` already has 6 real (tokens, %) calibration pairs from Phase 3
   to seed this.

3. **A real, unrelated bug that blocks accurate accounting today**: both
   `src/engines/claude-cli.ts` and `src/engines/codex-cli.ts` hardcode
   `usage: unknownUsage()` on every return path of `start()`/`startAsync()` - neither
   adapter parses the usage data its own CLI invocation already returns, even though
   both already request the right machine-readable output (`claude-cli.ts` passes
   `--output-format json` at line ~170; `codex-cli.ts` passes `--json` at line ~150).
   This is why every real-engine run this session showed
   `"usageTotals": {"inputUncachedTokens": null, ...}` in its report. Confirmed the
   data is actually present: a live `claude -p ... --output-format json` call returned
   a top-level `"usage"` object with exact `input_tokens`/`cache_creation_input_tokens`/
   `cache_read_input_tokens`/`output_tokens`/`total_cost_usd`; a live Codex `--json`
   rollout has the `token_count` event shown above. **Fixing this parsing is a
   prerequisite for the benchmark tool to have real per-task numbers to learn from**,
   not an optional nice-to-have - without it, `evidence.json`/`run-report.json` for
   real engines will keep reporting `null` usage forever, and the benchmark tool would
   have nothing but the fake engine's synthetic numbers to train on.

### Recommended sequencing

1. **Fix the `unknownUsage()` gap in both adapters. — done 2026-08-15.** Parsed the real
   CLI output already captured in `child.stdout`/the JSONL event stream into a proper
   `EngineUsage` for both `claude-cli.ts` and `codex-cli.ts` (`parseClaudeUsage()`/
   `parseCodexUsage()`). This closed a real correctness gap independent of the benchmark
   tool (section 18.1 of `IMPLEMENTATION-PLAN.md` already promised "accounting separat
   pentru input uncached, cache read, cache write, output și cost" - this was never
   actually delivered for real engines). Tested against fixtures built from the real
   JSON shapes captured above, no live CLI calls in tests -
   `tests/fixtures/engine-usage/`. 226/226 tests, `phase0`/`phase2` demos PASS, zero
   regressions. See `todo.md` #11 for the full writeup. Stages 2-6 below remain open.
2. **Local session-log readers. — done 2026-08-15.** `src/benchmark/read-claude-session.ts`
   and `src/benchmark/read-codex-session.ts`: pure parsers over file content
   (`parseClaudeSessionLog`/`parseCodexSessionLog`) plus a best-effort fs wrapper
   (`readClaudeSessionLog`/`readCodexSessionLog`, returns `null` rather than throwing on
   a missing/corrupt/unreadable file). `findClaudeSessionLogPath(sessionId)` scans every
   project directory for a matching session file instead of recomputing Claude Code's
   own (undocumented) project-hash algorithm; `findLatestCodexRolloutPath()` returns the
   most-recently-modified `rollout-*.jsonl`. Tested against fixture files
   (`tests/fixtures/engine-usage/claude-session-transcript.sample.jsonl`,
   `.../codex-rollout-token-count.sample.jsonl`), no live CLI calls.
3. **Checkpoint schema + store. — done 2026-08-15**, with two deliberate deviations from
   this spec: (a) JSONL only, no SQLite - `node:sqlite` availability wasn't needed once
   JSONL matched the existing `EventLog` pattern closely enough; (b) stored at
   `<resolvedStateRoot>/benchmarks/usage-checkpoints.jsonl` (`resolveUsageCheckpointLogPath()`
   in `src/benchmark/usage-checkpoint.ts`), not `.ai-code-worker/benchmarks/` - the
   resolved state root is the existing cross-run, per-repository location (siblings with
   `runs/`), while `.ai-code-worker/` is repo-committed config, the wrong place for a
   growing local history file. `UsageCheckpointLog` mirrors `EventLog`'s shape and
   corrupt-tail tolerance but drops its strict per-run sequence-gap invariant (checkpoints
   aren't a recovery-critical stream). Wired at **task** granularity into all three
   runners (`fake-run.ts`/`claude-run.ts`/`codex-run.ts`) at the single call site where
   the engine actually runs (`adapter.start()`/`engine.start()`) - deliberately NOT at
   every one of the 10+ early-return `BLOCKED` branches in each file, to stay additive
   rather than state-machine surgery (same caution the Phase 4 table below already
   calls for). Session-log readers from stage 2 are NOT called at task granularity - the
   Claude adapter's `--no-session-persistence` invocations never produce a local
   transcript to cross-check in the first place; the readers are used at run granularity
   instead (stage 6).
4. **Claude `%` calibration. — done 2026-08-15.** `src/benchmark/claude-calibration.ts`:
   `fitTokensPerPercentPoint()` takes the median tokens-per-%5h-point ratio (robust to a
   single outlier) over `SEEDED_CLAUDE_CALIBRATION_POINTS`, seeded with exactly the 6 real
   pairs from `docs/BENCHMARKS.md`'s Phase 3 stages 3-8 table (52.8k/4pp, 46.8k/4pp,
   28.2k/3pp, 23.1k/2pp, 58.8k/5pp, 23.4k/2pp → median ratio 11,700 tokens/pp).
   `estimateClaudePercentFromTokens()` is the estimate-only function; the checkpoint
   schema keeps `percentUsedReported` and `percentUsedEstimated` as two separate nullable
   fields precisely so they're never conflated.
5. **Estimator. — done 2026-08-15.** `src/benchmark/estimate.ts`: `estimateUsageForPlan()`
   buckets historical "end"-phase task checkpoints by `kind:risk`, returns
   low/median/high per bucket. A task whose bucket has zero samples gets `tokens: null`
   and is listed in `tasksWithoutHistory` - never silently assumed to cost 0, and the
   caller can tell a partial total from a complete one.
6. **Wire into `run` CLI. — done 2026-08-15**, with one scoping deviation: only the `run`
   command (not `doctor`, which has no plan/task dispatch to estimate against). Prints
   the pre-run estimate before dispatch in human mode; opt out with `--no-estimate`. In
   `--json` mode the estimate is folded into the same final report object
   (`{ ...report, preRunEstimate }`) rather than printed as a second JSON blob - the
   first draft printed it separately and broke an existing CLI test that assumed all of
   stdout was one JSON value; fixed and re-verified. Run-level checkpoints (`scope:
   "run"`, `taskId: null`) are written immediately before/after the
   `runFake`/`runClaude`/`runCodex` call, keyed off the report's returned `status` and
   `usageTotals` - deliberately NOT by hooking the `run.done`/`run.blocked` event-append
   call sites inside the three runners (same "don't touch the 10+ BLOCKED branches"
   reasoning as stage 3). Codex run-end checkpoints cross-check against the latest local
   rollout file (`findLatestCodexRolloutPath`); Claude run-end checkpoints compute
   `percentUsedEstimated` via the stage 4 calibration instead (no local %-reading exists
   to cross-check for Claude). Verified manually end-to-end, not just via tests: a fresh
   fixture repo's first `run` shows "no historical data yet"; a second `run` against the
   *same* repo shows a real estimate derived from the first run's checkpoints, including
   a calibrated %5h figure; `--json --no-estimate` produces a single valid JSON object
   with no `preRunEstimate` key.

**Part A is now fully implemented.** 254/254 tests (226 baseline + 28 new), `phase0`/
`phase2` demos PASS, zero regressions. See `todo.md` #12 for the consolidated writeup.

### Guardrails specific to this tool

- Never invoke a real `claude`/`codex` CLI call from a *test* just to observe its
  output shape - capture one real sample per engine (already done implicitly this
  session, redo deliberately and save as fixtures) and replay those in tests. Real
  calls cost real money and this tool's own tests must not be a source of ongoing
  spend.
- Local session-log paths (`~/.claude/projects/...`, `~/.codex/sessions/...`) are
  **outside the repository and outside `$STATE_ROOT`** - treat them as a read-only,
  best-effort data source (may not exist, may be in a different location on another
  OS/user, format may change with CLI updates) with graceful fallback to "no local
  log available" rather than a hard failure.
- Don't persist raw transcript content from these logs into repo artifacts - only
  derived numeric fields (matches the redaction guardrails from Phase 3 stage 9).

## Part B: what's left in ai-code-worker overall

### Phase 4 — `ai-code-control` adapter & distribution

No dedicated handoff exists yet for this phase (unlike Phase 3). Derived from
`docs/IMPLEMENTATION-PLAN.md` §"Faza 4":

| # | Stage | Note |
|---|---|---|
| 1 | `ai-code-control` provider skeleton - CLI JSON contract, optional/feature-flagged | **Done 2026-08-15.** Exit criterion held by construction: not wired into any call site yet. `src/context-provider/`, 5 new schemas, 12 tests. |
| 2 | Wire health/brief/impact/scope/refresh at the correct pipeline points | **Done 2026-08-15.** Single call site (`cli.ts` run command), not the three runners. find-symbol/impact-analysis per task was deliberately deferred here (no symbol-identification capability existed to drive it) - resolved 2026-08-15 (post-Part-B "Task D") via an explicit, plan-author-declared `relevantSymbols` field on manifest tasks instead of an invented heuristic; run-level lookup, not per-task. |
| 3 | Redacted handoff export | **Done 2026-08-15.** Reused `src/runner/redaction.ts` / `src/report/export-artifacts.ts` from Phase 3 as planned. Double explicit gate: provider active AND new `handoffExport: true` config key. |
| 4 | `init`/`update` with managed, versioned config blocks | **Done 2026-08-15.** New CLI surface (`src/config/init.ts`); `update` is an additive-only top-level key merge, never touches existing values. |
| 5 | Bootstrap/pilot submodule onboarding + upgrade docs | **Done 2026-08-15.** `docs/ONBOARDING.md`. Reading the plan closely for this surfaced two real gaps in stage 4's `init` (`--engines`, the AGENTS.md block proposal) - folded in here rather than reopening stage 4. |
| 6 | Codex/Claude compatibility matrix | **Done 2026-08-15.** `docs/compatibility-matrix.json` + schema, with a dedicated drift test against the real `testedVersionRanges`/capability constants in code. |
| 7 | Optional package/plugin shims | **Done 2026-08-15.** `.codex/agents/*.toml` + `.agents/skills/.../SKILL.md`, `.claude/agents/*.md` + `.claude/skills/.../SKILL.md`, per IMPLEMENTATION-PLAN.md §12.1/§12.2 - closes a Phase 1 deliverable ("installer și skill Codex minimal") that had never actually landed. |
| 8 | Stable distribution channel decision (npm / signed executable / submodule / external CLI + versioned config) | **Deferred 2026-08-15, intentionally** - decision + config, not heavy code, needs user input, not just implementation. `docs/DISTRIBUTION.md` lays out all four options with real trade-offs (including a packaging constraint discovered while building stages 1-7: `SchemaRegistry`/`installShims()` resolve `schemas/`/`templates/` relative to the repo root at runtime, which is free for submodule/external-CLI but real repackaging work for npm/signed-executable). See `todo.md` #13. |

**Stages 1-7 are fully implemented** (296/296 tests, `phase0`/`phase2` demos PASS at
every stage, zero regressions throughout). Stage 8 is the one deliberately left open -
see `docs/DISTRIBUTION.md` and `todo.md` #13.

Rough estimate (from Phase 3's real calibration, ~9-13k tokens per %5h point for a
normal-sized stage): comparable order of magnitude to Phase 3, ~35-45pp of %5h
equivalent, ~400-550k tokens total - will not fit in a single 5h window/session,
plan for multiple.

### Phase 5 — SDKs & advanced operation (post-stabilization only)

Not needed for first stable release per the plan: Codex SDK / Claude Agent SDK
adapters, OpenTelemetry, draft-PR adapter, agent teams (experimental only), isolated
remote/CI backends, policy signing/SBOM. Don't start this before Phase 4 ships.

### Standing follow-ups (already in `todo.md`, just cross-referencing)

- `todo.md` #9: real independent-review engine call.
- `todo.md` #10: Codex behavioral verification depth (currently smoke-test only for
  0.148.0-alpha.9).

## Commands to run before starting either part

```powershell
git switch main
git pull --ff-only origin main
npm ci
npm test
npm run phase0:demo
npm run phase2:demo
```

## Commands expected before handoff (whichever part is picked up)

```powershell
npm test
npm run phase0:demo
npm run phase2:demo
```

Continue updating `docs/BENCHMARKS.md` per its existing protocol for any new session
that develops these parts (checkpoint at stage start/end, `/usage` on request) - this
handoff doesn't replace that log, it's what comes after it if the tool described in
Part A eventually automates it.
