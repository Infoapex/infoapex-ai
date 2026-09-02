# P2-B live report

Status: **functional PASS; economic inconclusive** (same distinction as P2-A, now
confirmed at 10 real sequential invocations instead of 2).

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
| Cache-write tokens | unknown (`null` ×5) | 42,364 |
| Output tokens | 2,364 | 3,263 |
| USD cost | unknown (`null` ×5) | $0.3658 total |
| Usage completeness | `partial` ×5 | `complete` ×5 |
| Wall time | 149.6s total (~29.9s/task) | 97.0s total (~19.4s/task) |

Codex's `exec --json` again omitted usage entirely on 0.147.0 (same gap as P2-A); every
Codex figure above is the sanitized local-rollout fallback, still missing cache-write
and cost. Claude's usage is complete and directly comparable across all 5 tasks.

**Combined economic verdict stays `inconclusive`** — not because any task failed, but
because Codex CLI 0.147.0 structurally does not report cache-write tokens or USD cost.
This is an external CLI limitation, not a defect in this pilot or in `ai-code-worker`'s
usage parsing (already verified correct against the real envelope shape in P2-A and
again here). It will remain `inconclusive` until Codex's own CLI exposes those fields.

Claude's own economic comparability is real and usable on its own: 5/5 complete reports,
~$0.073/task, ~45.6k tokens/task uncached+cache-read+cache-write+output combined.

P2 is closed on this basis: both the 2-invocation preflight (P2-A) and the 10-task
live pilot (P2-B) are functional PASS, `GRAPH-06` remained disabled throughout as
frozen, and the economic gap is fully attributed and documented rather than hidden or
guessed. Enabling `GRAPH-06` parallel reviewers is a separate, distinct decision
(a preregistered A/B experiment) and remains pending its own explicit authorization —
this pilot supplies the sequential baseline that experiment depends on, but does not
itself authorize it.
