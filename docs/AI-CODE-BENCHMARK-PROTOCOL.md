# AI code benchmark protocol v1

## Preregistration

Before an experiment starts, freeze and hash the suite, tasks, arms, repetitions,
seed, engine/model/effort, budgets, environment allowlist, primary metrics, exclusion
rules, and decision thresholds. Raw observations are immutable; corrections append
an adjudication event. Configuration changes create a new experiment ID.

The bounded P4.5 pilot budget is at most 10 tasks and 30 invocations for one provider
across A/B/C. A second provider is allowed only in a separate experiment and window.
This budget is approved for validation of the harness and directional evidence, not
for public ranking claims.

## Observations

Order is deterministically shuffled and balanced by seed. Each arm starts from the
same base commit in a fresh isolated directory. Provider time and harness time are
recorded separately. Manual action is prohibited unless the protocol allows it; any
action is appended to the intervention log with duration and reason.

An observation is complete only when execution, diff capture, scope validation,
gates, oracle checks, usage normalization, and artifact hashing have terminal events.
A resume uses the stable observation ID and skips terminal steps.

## Metrics and verdicts

Report quality (gate/oracle pass), safety (scope/security), latency, provider usage,
human interventions, and metric completeness separately. Paired arm deltas use only
matching tasks and repetitions. Confidence intervals and sample counts accompany
every aggregate; there is no opaque composite score.

Candidate P5 verdicts are `ACCEPT`, `REJECT`, `INCONCLUSIVE`, or
`ACCEPT_WITH_LIMITS`. Missing primary data, fewer than 90% valid observations, a
protocol hash mismatch, or insufficient paired samples produces `INCONCLUSIVE`.
Critical safety failure produces `REJECT`. Thresholds for quality/cost tradeoffs are
declared by the candidate hypothesis before execution.

## Inventory of available measurements

| Source | Available now | Authority |
|---|---|---|
| provider JSONL | input/cache/output tokens, elapsed execution, model/session when exposed | secondary, parser-versioned |
| Infoapex worker report | normalized usage, task outcome, retries/repairs, evidence | secondary plus provenance |
| Git/filesystem | patch, changed paths, base/head, artifact hashes | primary for scope/change |
| benchmark gates/oracles | command status and task-specific assertions | primary for quality |
| intervention log | count, duration, reason | primary when signed by controller |
| account gauge | rounded five-hour usage and reset | contextual, never allocated exactly |

Direct Claude support is capability-tested at runtime; absence is `UNSUPPORTED`, not
a fallback. Arm C similarly requires a healthy public `ai-code-control` adapter.

