# P2-A live report

Status: **functional PASS; economic inconclusive**.

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
`DONE`, no fallback occurred, and `GRAPH-06` remained disabled. P2-B may proceed as
a functional controlled comparison, but must keep any combined economic verdict
`inconclusive` while Codex USD cost remains unknown.
