# Usage telemetry v1

Usage telemetry is evidence, not an estimate. Unknown provider fields stay
`null`; they are never converted to zero. Every run report carries a separate
assessment:

- `complete`: all token and reported-cost fields are known;
- `partial`: at least one field is known and at least one is unknown;
- `unavailable`: no usage field is known;
- `comparable`: only a complete report may support an economic comparison;
- `inconclusive`: execution may still succeed, but no economic claim is allowed.

`normalized-usage.schema.json` versions the machine contract. Samples identify a
provider parser version, invocation series, sequence and accounting mode.
Incremental samples are summed. For a cumulative series only the highest sequence
contributes. Identical replayed `sampleId` values are deduplicated; content drift
or mixed accounting modes fail closed.

This distinction covers retries, fallback and resume:

- a retry or fallback is a new invocation series and its real usage is added;
- replaying an already persisted sample after resume does not add it again;
- repeated cumulative provider events do not inflate the total;
- missing cost or cache fields make the economic verdict `inconclusive`, without
  turning a functionally valid run into a failure.

Current sanitized parser fixtures are:

- `tests/fixtures/engine-usage/codex-rollout-token-count.sample.jsonl` for
  `codex-token-count.v1`;
- `tests/fixtures/engine-usage/claude-output-format-json.sample.json` for
  `claude-result.v1`.

## Quota-percent usage (2026-09-02)

`economicVerdict` no longer depends on `costUsd`. Both Codex and Claude are used here
on flat-rate ($20/mo) subscriptions, not pay-per-token API billing - `costUsd` is
frequently unavailable by design (see `docs/RELEASE-GATES.md`) and, even when present,
never reflected a real marginal cost under a subscription. The metric that does reflect
real cost is how much of the rolling 5-hour rate-limit window a task/run consumed - see
`src/usage/quota-usage.ts`.

Two sources, never conflated:

- `measured`: read directly from Codex's local rollout (`rate_limits.primary`/
  `secondary`, confirmed present on real CLI 0.147.0). A real, provider-reported
  number, same status as a token count.
- `estimated`: Claude has no local %5h/%week reading anywhere (confirmed) - its
  percent is derived from a real token count via a tokens-per-point ratio, calibrated
  from `claude-calibration.ts`'s seeded points (manual, from `docs/BENCHMARKS.md`) or,
  for Codex, self-calibrated automatically from this project's own run history (see
  `deriveCodexCalibrationPoints` in `benchmark/estimate.ts` - every completed real
  Codex run is its own calibration point, since its percent is measured, not guessed).

`economicVerdict` is `comparable` whenever a task/run's 5-hour percent is known,
`measured` or `estimated` - regardless of whether `costUsd` is. `assessUsageTotals`
still reports `completeness`/`unknownFields` over the 5 raw token/cost fields exactly
as before; only the definition of `economicVerdict` changed.

**Gauge, not an amount - read `quotaUsage` carefully.** A `measured` Codex reading is
the account's cumulative usage of its rolling window *at that moment*, not this task's
share of it: a task run right after other, unrelated Codex activity on the same account
can show a high `fiveHour.percent` that has nothing to do with that task's own cost
(see `validation/p2-a/LIVE-REPORT.md` for a real example). An `estimated` Claude
reading, by contrast, genuinely is that task's own share (it's derived from that task's
own token count), so per-task Claude percentages are additive across a run; per-task
Codex percentages are not - only the first/last reading in a run is meaningful, not a
sum. `report/run-report.ts`'s `quotaUsage` field is a run-level snapshot, not summed
across the run's tasks, for exactly this reason.

A `maximumRunFiveHourPercent` budget (`schemas/manifest.schema.json`) can be declared
per plan and is evaluated in `run-report.ts` via `evaluateQuotaBudget()` - but only
**post-hoc**, after the run's real quota reading is known, unlike the token/cost
budgets in `policy/usage-budget.ts` which block mid-run. A live quota reading can only
be discovered after an invocation completes, so it can inform the *next* run's budget,
not stop the run that exceeded it.
