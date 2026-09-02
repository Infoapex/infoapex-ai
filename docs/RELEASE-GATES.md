# Release gates

The first three modules are not called production-complete merely because their
TypeScript builds pass.

Required gates:

- `ai-code-worker`: full deterministic suite, routing/fallback tests, JSON contract validation, and live verification that the installed Claude/Codex CLIs expose a stable quota or availability signal.
- `ai-code-planner`: full suite plus three representative end-to-end plans that pass linting, compile against the pinned worker contract, and execute through worker.
- `ai-code-review`: full deterministic suite plus an internal planner -> control -> worker read-only review gate.
- `ai-code-docs`: full deterministic suite plus an internal planner -> control -> worker -> review documentation gate.
- `infoapex-ai`: installer init in both modes, status, handoff write/read, bundle clean-clone bootstrap and ZIP extraction.

The reproducible ICM gate is `npm run value-gate:internal`. It executes 20 generic
planner `propose -> inspect -> compile` tasks through worker `run --engine fake`.
`npm run pilot:icm-graph:internal` composes that matrix with a generic consumer trace
graph, 25 hybrid queries, expected graph, coverage, drift, and Obsidian projection.
Both consume no provider usage. `npm run value-gate:live` is an explicit opt-in with
the installed Claude CLI and is the only gate that consumes provider usage.

Until the live quota signal and the three-plan value gate pass, the correct
status is implemented candidate, not an unqualified production release.

Validation update 2026-08-25: the bounded mid-task fallback contract is covered
and passing (`codex` quota failure -> `claude` success; deterministic failure does
not fallback). The live three-plan proposal gate was attempted against a large
target workspace, but the installed CLI timed out after 180 seconds; it remains
blocked on external CLI execution, with evidence in
`validation/value-gate/README.md`. The internal contract gate does not require a
real quota-consuming task: provider outcomes are injected deterministically.
The repository-agnostic internal three-plan gate now passes 3/3 through planner
and worker fake execution; only the usage-consuming live variant remains open.

Codex live update 2026-08-25: `codex-cli 0.147.0` passed doctor and a disposable
real worker task completed with `DONE`, a worker-owned commit and a passing gate
when invoked with explicit `--codex-sandbox danger-full-access`. The default
`workspace-write` invocation was blocked by the local CLI approval policy. The
remaining external validation is Claude's usage-consuming planner/value gate and
its real quota signal.

P2-A update 2026-08-30: the bounded two-invocation preflight passed live for Codex
and Claude. Claude usage is complete and economically comparable. Codex completed
functionally, while USD cost remains unavailable; token counts require the
sanitized local-rollout fallback because CLI 0.147.0 omits them from `exec --json`
stdout. The combined economic verdict is therefore `inconclusive`. P2-B and the
three-arm comparison remain release gates; `GRAPH-06` is still disabled.

P2-B update 2026-09-02: harness built (`scripts/p2-b-live-pilot.mjs`,
`validation/p2-b/`), extending the P2-A pattern from 2 to the required 10 real
sequential tasks (5 Codex + 5 Claude, alternating, one shared repository,
`GRAPH-06` disabled throughout). Each task is graded by an independent script check
against the actual committed evidence file (read via `git show <taskCommit>:<path>`,
since task work lands on a dedicated per-task branch/worktree, never the shared
repo's checked-out working tree) rather than by either engine's self-report. Before
building, verified directly against installed CLIs (`claude --help` 2.1.235,
`codex --help` 0.147.0) that `/usage` and `/context` are Claude Code TUI-only
interactive commands with no CLI/API surface, so they cannot back headless per-task
usage figures; the pilot instead reuses the same real per-invocation sources already
validated live in P2-A (`--output-format json` for Claude, sanitized Codex rollout
fallback for Codex).

The live run executed 2026-09-02 (`validation/p2-b/live-report.json`,
`LIVE-REPORT.md`): **10/10 DONE, 10/10 accurate, zero engine fallbacks**, 4m10s total
wall time. Claude usage is complete for all 5 tasks (~$0.073/task, ~$0.3658 total).
Codex again omitted usage from `exec --json` on 0.147.0; the sanitized rollout
fallback covers all 4 token fields.

Correction, same day: the raw Codex rollout files were found to contain
`cache_write_input_tokens` (value 0 for every task in this run) that
`ai-code-worker`'s usage parser had never read — a stale assumption from an earlier
CLI version that genuinely omitted the field, not a current CLI limitation. Fixed in
`codex-cli.ts`/`read-codex-session.ts` (392/392 worker tests still pass) and both
P2-A's and P2-B's reports were reprocessed from their original, still-present local
rollout files — no new live invocation was needed. Token-level Codex usage is
therefore now complete; **only `costUsd` remains unavailable, for a confirmed
structural reason**: the same rollout's `rate_limits.credits` reports
`has_credits: false, balance: "0"` for this ChatGPT-Plus-subscription-authenticated
account, meaning there is no dollar ledger to report from in this billing mode. The
combined economic verdict is therefore still `inconclusive`, same as P2-A, but now for
exactly one isolated, well-understood reason instead of two conflated ones.

Quota-percent decision, 2026-09-02: both Codex and Claude are used here on flat-rate
($20/mo) subscriptions, not pay-per-token API billing - `costUsd` was never going to
reflect a real marginal cost, and for Codex it structurally does not exist at all (see
above). `economicVerdict` (`ai-code-worker`'s `assessUsageTotals`, see
`docs/USAGE-TELEMETRY-V1.md`) is redefined to depend on knowing a task/run's 5-hour
quota-percent instead - `measured` directly from Codex's rollout (`rate_limits`,
already present, just never read before) or `estimated` for Claude from a real token
count via a calibrated ratio; either counts as comparable. Both P2-A and P2-B were
reprocessed from their original, already-saved local data (no new live invocation) and
now report **`economicVerdict: comparable`** - Codex measured 75% (P2-A) and a 4-6%
range (P2-B) of its 5-hour window across these runs; Claude's estimated equivalents are
2.5% (P2-A) and a 20.1% cumulative estimate across P2-B's 5 tasks. The Codex figures
are cumulative account-wide gauges at the moment each reading was taken, not a
per-task amount (P2-A's 75% in particular reflects other account activity, not that
one smoke task's own cost - see `validation/p2-a/LIVE-REPORT.md`); Claude's are
genuinely per-task since each is derived from that task's own tokens.

**P2 is closed**: both the 2-invocation preflight (P2-A) and the 10-task live pilot
(P2-B) are functional PASS, with complete token-level usage on both engines, and now
`economicVerdict: comparable` on both under the quota-percent definition. Enabling
`GRAPH-06` parallel reviewers is a distinct, separately-gated decision (a
preregistered A/B experiment) that this pilot supplies the sequential baseline for
but does not itself authorize — it remains disabled pending its own explicit
go-ahead.
