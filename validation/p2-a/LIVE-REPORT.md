# P2-A live report

Status: **functional PASS; economic inconclusive**.

The frozen preflight executed exactly two sequential provider invocations. Codex
0.147.0 with `gpt-5.6-sol/high` completed in 21.940 seconds. Its `exec --json`
stdout omitted usage, but the matching local rollout exposed a cumulative sanitized
token event: 9,059 uncached input, 52,224 cache-read and 377 output tokens. Cache
write and USD cost remain unknown.

Claude Code 2.1.235 with the frozen `sonnet` selection completed in 13.540 seconds
and reported complete usage: 4 uncached input, 21,521 cache-read, 7,449 cache-write,
323 output tokens and USD 0.0560073.

Quota and sandbox/provider failures were classified as fallback-eligible;
deterministic implementation failure was not. Both functional smoke tasks were
`DONE`, no fallback occurred, and `GRAPH-06` remained disabled. P2-B may proceed as
a functional controlled comparison, but must keep any combined economic verdict
`inconclusive` while Codex USD cost remains unknown.
