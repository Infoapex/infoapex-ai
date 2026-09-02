# P2-B live pilot

P2-B extends the frozen P2-A live-invocation harness (2 smoke tasks) to the 10 real
sequential tasks required by `todo.md`: "Run the bounded usage-consuming common ICM +
Graph pilot on 10 real sequential tasks ... record accuracy, retries, uncached context,
total tokens and explanation time."

## What "10 real sequential tasks" means here

One shared, disposable repository, initialized once (`ai-code-worker init`), then run
through 10 separate `ai-code-worker run` invocations, one after another (never
parallel — `GRAPH-06` stays disabled, matching P2-A). Engines alternate 5 Codex / 5
Claude (`PILOT-B-01` = Codex, `PILOT-B-02` = Claude, ...) against a shared 5-pair
contract+source fixture, so both providers are exercised against the same material in
the same session.

Each task asks the engine to read one `src/pilot-K.ts` and its `contracts/pilot-K.schema.json`,
then write `pilot/evidence-NN.json` with the contract's `$id` and the exact list of
exported function names it found — a small but genuine reading/extraction task, graded
by a script (`scripts/verify-pilot-evidence.mjs`, written into the fixture repo), not by
either engine's own self-report. `allowedPaths`/`forbiddenPaths` restrict each task to
its own evidence file, so this also re-exercises real scope enforcement under live
engines, not just correctness.

`--independent-review` is never enabled here: it invokes the *other* engine as a
cross-reviewer after every run, which would silently double the live-invocation count
past the frozen budget of 10. Repair-cycle retries are consequently out of scope for
this pilot.

## Metrics and where they actually come from

Verified directly against installed CLIs before building this (`claude --help`,
`codex --help`) and against `validation/p2-a/live-report.json` (a real live run,
2026-08-30, same CLI versions frozen here): **`/usage` and `/context` are Claude Code
TUI-only interactive slash-commands with no CLI or API surface.** They report this
*session's* account-level `%5h`/`%week` budget, not the usage of a single headless
`claude -p ...` invocation. They are not used anywhere in this pilot.

| Metric | Source | Notes |
|---|---|---|
| `accurate` | worker `status === "DONE"` **and** an independent re-read of the evidence file | Read via `git show <taskCommit>:<evidencePath>` from `run-report.json`'s `taskCommits` — task work lands on a dedicated `aiw/task/<runId>/<taskId>/attempt-N` branch in its own worktree, never checked out into the shared repo's main working tree, so reading the path directly from the repo root always misses it. |
| `fallbacksTriggered` (retries) | `engineProvenance.engineFallbackTriggered` | Doctor-level `--fallback-engine` activation before a task starts (already live-validated, P2-A/#19). Not a mid-task or repair-cycle retry — see above. |
| `uncachedContextTotal` / total tokens | `usage.inputUncachedTokens` + the other 3 categories | Claude: complete, from `--output-format json`'s `usage` object. Codex: `exec --json` omits usage on 0.147.0 (confirmed live in P2-A and again here); falls back to the sanitized local rollout (`~/.codex/sessions/**`), which does include `cache_write_input_tokens` (fixed 2026-09-02 — a prior version of this parser wrongly treated it as never-surfaced) but never `costUsd`. `totalTokens` for a group is only computed when every task in it has complete usage. |
| `costUsd` | `--output-format json`'s `total_cost_usd` (Claude only) | Structurally unavailable for Codex under this account's ChatGPT-Plus-subscription auth, not a parsing gap: the same rollout's `rate_limits.credits` reports `has_credits: false, balance: "0"` — there is no dollar ledger to report from in this billing mode. **No longer what `economicVerdict` depends on** — see next row. |
| `quotaUsage` / `economicVerdict` | `run-report.json`'s `quotaUsage` (2026-09-02 addition) | Both accounts are flat-rate ($20/mo) subscriptions, so 5-hour quota-percent, not `costUsd`, is the real cost signal. Codex: `measured` directly from `rate_limits.primary` in its rollout (a real per-account gauge, not a per-task amount — see `LIVE-REPORT.md`'s reading-order caveat). Claude: `estimated` from that task's own tokens via a calibrated ratio (`quota-usage.ts`, `claude-calibration.ts`) — genuinely per-task, additive across a run. `economicVerdict` is `comparable` whenever the 5-hour percent is known, either source. |
| explanation time | wall-clock `elapsedMs` of the `run` invocation | No installed CLI exposes a separate reasoning-only timer; documented as a proxy, not a measured quantity. |

## Running it

Deterministic, consumes no provider quota (fake CLI wired to write correct evidence
content per task, same fixture-executable technique as P2-A):

```powershell
npm run p2b:pilot
```

Live, an explicit quota-consuming opt-in — 5 real Codex + 5 real Claude invocations:

```powershell
node scripts/p2-b-live-pilot.mjs --live --json --out validation/p2-b/live-report.json
```

As with P2-A, `economicVerdict` is `comparable` only when every task in the run has a
known 5-hour quota-percent (2026-09-02 redefinition — see the table above). The actual
2026-09-02 live run reprocessed cleanly to `economicVerdict: comparable` on both
engines. Per-engine summaries in the report keep Codex's measured, gauge-based
percentages and Claude's estimated, per-task percentages separate rather than mixing
them into one figure. See `LIVE-REPORT.md` for the full account, including the
cache-write parser fix and why `costUsd` specifically, not tokens or quota, is the one
field that remains structurally unavailable for Codex.
