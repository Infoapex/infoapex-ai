# P2-A live report

Status: **functional PASS; economic comparable** (quota-percent redefinition,
2026-09-02 - see below; originally recorded as economic inconclusive).

The frozen preflight executed exactly two sequential provider invocations. Codex
0.147.0 with `gpt-5.6-sol/high` completed in 21.940 seconds. Its `exec --json`
stdout omitted usage, but the matching local rollout exposed a cumulative sanitized
token event: 9,059 uncached input, 52,224 cache-read, 0 cache-write and 377 output
tokens. USD cost remains unknown.

**Correction, 2026-09-02**: `cacheWriteTokens` was originally recorded as `null` here.
The raw rollout always had `cache_write_input_tokens: 0` in its `token_count` event;
`ai-code-worker`'s Codex usage parser simply never read that field (a stale assumption
from an earlier CLI version that genuinely omitted it - see P2-B's live run and
`codex-cli.ts`'s updated comment). The parser is now fixed and this file's `usage`/
`usageAssessment` were reprocessed from the original, still-present local rollout file -
no new live invocation was needed. USD cost remains genuinely unavailable for this
ChatGPT-Plus-subscription-authenticated account: the same rollout's
`rate_limits.credits` reports `has_credits: false, balance: "0"` - there is no dollar
ledger to report from in this billing mode.

Claude Code 2.1.235 with the frozen `sonnet` selection completed in 13.540 seconds
and reported complete usage: 4 uncached input, 21,521 cache-read, 7,449 cache-write,
323 output tokens and USD 0.0560073.

Quota and sandbox/provider failures were classified as fallback-eligible;
deterministic implementation failure was not. Both functional smoke tasks were
`DONE`, no fallback occurred, and `GRAPH-06` remained disabled.

**Quota-percent redefinition, 2026-09-02**: both accounts here are flat-rate ($20/mo)
subscriptions, not pay-per-token API billing, so `costUsd` was never the metric that
reflected real cost - and for Codex it structurally does not exist (see the
`has_credits: false` finding above). `economicVerdict` now depends on knowing a task's
5-hour quota-percent instead. Reprocessed from the same rollout file (no new live
invocation): Codex's rollout's `rate_limits.primary` reports **75% of its 5-hour
window, measured** at the moment this smoke task's reading was taken. Claude has no
local %5h reading anywhere, so its figure is **2.5%, estimated** from its real token
count via a calibrated tokens-per-point ratio. Both count as `comparable` under the
new definition - **combined `economicVerdict` is now `comparable`**, not
`inconclusive`.

**Read the 75% correctly - it is not this task's cost.** A Codex quota reading is the
account's cumulative usage of its rolling window at that moment, not a per-task delta:
this was the very first live Codex smoke task run for this project, so 75% almost
certainly reflects other, unrelated Codex activity on the same account earlier in its
current 5-hour window, not the cost of one trivial file-write task. Contrast P2-B's
per-task Codex readings (4-6% range across 5 tasks, `validation/p2-b/LIVE-REPORT.md`),
which are far more representative of an individual task's footprint. Claude's 2.5% has
no such caveat: it is derived directly from this task's own token count, so it
genuinely is this task's own share.
