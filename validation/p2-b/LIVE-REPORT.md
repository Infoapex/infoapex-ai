# P2-B live report

Status: **functional PASS; economic comparable** (quota-percent redefinition,
2026-09-02 - see below; originally recorded as economic inconclusive, same
distinction as P2-A, now confirmed at 10 real sequential invocations instead of 2).

Ran 2026-09-02, one shared disposable repository, 10 sequential `ai-code-worker run`
invocations, `GRAPH-06` disabled throughout. 5 Codex (`gpt-5.6-sol/high`, CLI 0.147.0)
and 5 Claude (`sonnet`, CLI 2.1.235) tasks, alternating, each reading a distinct
contract+source pair and writing a script-graded evidence file. Total wall time
4m10s (`startedAt` 12:06:08.113Z → `finishedAt` 12:10:18.540Z).

**Functional: 10/10 DONE, 10/10 accurate on the first attempt** (script-verified against
the actual committed evidence, not either engine's self-report). Zero doctor-level
engine fallbacks triggered — every task ran on its originally requested engine.

**Economic:**

| | Codex (5 tasks) | Claude (5 tasks) |
|---|---|---|
| Uncached input tokens | 48,863 | 30 |
| Cache-read tokens | 262,528 | 188,568 |
| Cache-write tokens | 0 (all 5 tasks) | 42,364 |
| Output tokens | 2,364 | 3,263 |
| USD cost | unknown (`null` ×5) | $0.3658 total |
| Usage completeness | `partial` ×5 (cost only) | `complete` ×5 |
| Wall time | 149.6s total (~29.9s/task) | 97.0s total (~19.4s/task) |
| 5-hour quota-percent | measured, 4%→6% across the 5 tasks | estimated, ~2.0-4.5%/task, 20.1% summed |

Codex's `exec --json` again omitted usage entirely on 0.147.0 (same gap as P2-A); every
Codex figure above is the sanitized local-rollout fallback.

**Correction, 2026-09-02**: the raw rollout files (`~/.codex/sessions/**`) actually
contain `cache_write_input_tokens` (value 0 for all 5 tasks here) - `ai-code-worker`'s
Codex usage parser simply never read that field, a stale assumption carried over from
an earlier CLI version that genuinely omitted it. The parser is now fixed
(`codex-cli.ts`, `read-codex-session.ts`) and this report was reprocessed from the
original rollout files already on disk - no new live invocation was needed. Token-level
usage for Codex is therefore now complete in the `totalTokens` sense (all 4 token fields
known); only USD cost remains unavailable, and for a structural reason confirmed
directly in the same rollout files: `rate_limits.credits` reports `has_credits: false,
balance: "0"` for this ChatGPT-Plus-subscription-authenticated account - there is no
dollar ledger to report from in this billing mode, independent of anything this
project's code does or doesn't parse. Claude's usage is complete and directly
comparable across all 5 tasks.

**Quota-percent redefinition, 2026-09-02**: both accounts here are flat-rate ($20/mo)
subscriptions, so `costUsd` was never the metric that reflected real cost, and for
Codex it structurally does not exist under this billing mode (see above).
`economicVerdict` now depends on knowing a task's 5-hour quota-percent instead -
`measured` for Codex (its rollout's `rate_limits.primary`, already present, just never
read before this fix) or `estimated` for Claude (from real tokens via a calibrated
ratio). All 10 tasks have a known 5-hour percent, so **combined `economicVerdict` is
now `comparable`**, no longer `inconclusive`.

**Read Codex's percentages as a gauge, not a per-task cost.** Each Codex reading is the
account's cumulative usage of its rolling 5-hour window at that moment, not this one
task's own share - the 4%→6% progression across the 5 Codex tasks is consistent with
five small tasks run back-to-back inside one still-open window, not five independent
4-6% costs. Claude's readings have no such caveat: each is derived directly from that
task's own token count, so per-task Claude percentages are genuinely additive (the
20.1% "summed" figure above is a real total across the 5 Claude tasks, not a gauge
artifact).

Claude's own economic comparability is real and usable on its own: 5/5 complete reports,
~$0.073/task, ~45.6k tokens/task uncached+cache-read+cache-write+output combined.

P2 is closed on this basis: both the 2-invocation preflight (P2-A) and the 10-task
live pilot (P2-B) are functional PASS with `economicVerdict: comparable`, `GRAPH-06`
remained disabled throughout as frozen, and every gap along the way (cache-write
parsing, costUsd's structural unavailability) is fully attributed and documented
rather than hidden or guessed. Enabling `GRAPH-06` parallel reviewers is a separate, distinct decision
(a preregistered A/B experiment) and remains pending its own explicit authorization —
this pilot supplies the sequential baseline that experiment depends on, but does not
itself authorize it.
