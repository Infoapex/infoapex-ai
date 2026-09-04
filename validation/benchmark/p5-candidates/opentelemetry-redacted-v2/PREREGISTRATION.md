# P5 OpenTelemetry live candidate preregistration

Frozen before the first provider invocation on 2026-09-04.

## Baseline and isolated change

- Registered pre-P5 baseline: BENCH-09 R5, experiment hash `aeb52bf31b7602687c585237ddf001bd7c4bd76916773abcde4be66ebaf7cd79`.
- Live candidate suite: `p5-otel-live-v1`.
- Baseline arm: full Infoapex orchestration with `INFOAPEX_OTEL_ENABLED` absent.
- Candidate arm: the same orchestration with only `INFOAPEX_OTEL_ENABLED=1`.
- Provider/model/effort: Codex / `gpt-5.6-luna` / `medium` in both arms.
- Matrix: 10 trusted BENCH-09 fixtures x 2 arms x 1 repetition = at most 20 provider invocations.
- Oracle access: evaluator-only. Provider fallback, network expansion, publication, and secret forwarding are disabled.

## Frozen decision rule

The candidate must improve paired eligible trace coverage by at least `0.95`, with:

- zero regression in verified task success;
- paired candidate overhead no greater than `5%`;
- zero detected telemetry leakage.

The possible verdicts are `ACCEPT`, `REJECT`, `INCONCLUSIVE`, and
`ACCEPT_WITH_LIMITS`. A critical safety failure overrides all other results with
`REJECT`. Fewer than 90% valid observations or missing primary evidence produces
`INCONCLUSIVE`.

## Budget and stop policy

The pre-run estimate is approximately 15 percentage points of the rolling 5-hour
allowance and 4 percentage points of the weekly allowance for all 20 observations,
based on BENCH-09 R5. The last pre-run gauges were 22% (5-hour) and 81% (weekly).
Execution starts with one 2-observation paired canary and continues in bounded
batches. Stop before the remaining matrix if the canary has missing trace evidence,
detected leakage, provider rejection/fallback, a critical safety failure, or if the
observed quota trajectory projects either allowance to 95% or more.

The signed authorization is local, Ed25519-bound to the frozen experiment hash and
hypothesis hash, has scope `P5-OTEL`, and permits exactly 20 invocations. Its private
key is never persisted.
