# Retrospective P5 candidate evaluation: redacted OpenTelemetry v1

Candidate manifest: `candidate-hypothesis.json`.

This evaluation is retrospective: OpenTelemetry was implemented before this
hypothesis was frozen. It can establish implementation evidence, but cannot make a
prospective causal claim or accept the P5 change without a valid baseline/candidate
experiment.

## Threshold assessment

| Planned threshold | Evidence | Assessment |
|---|---|---|
| Zero leakage | `ai-code-worker` telemetry redaction tests assert an allowlist, drop paths, drop secret-shaped values, and inspect every generated span/event attribute. | PASS for the tested synthetic fixture; not a live benchmark verdict. |
| Harness overhead under 5% | No frozen paired run with telemetry disabled/enabled measures equivalent wall time or provider time. | INCONCLUSIVE. |
| At least 95% trace coverage of eligible events | The enabled fixture proves schema-valid, correlated spans and task/gate nesting, but does not record a denominator of all eligible events across a frozen suite. | INCONCLUSIVE. |
| No verified-task-success regression | The first BENCH-P result is REJECT because of a benchmark timeout/cleanup race and cannot be attributed to this candidate. No valid baseline is established. | INCONCLUSIVE. |

## Evidence inspected

- `modules/ai-code-worker/docs/adr/0012-redacted-opentelemetry-tracing.md`
- `modules/ai-code-worker/schemas/otel-span.schema.json`
- `modules/ai-code-worker/tests/unit/telemetry-redaction.test.ts`
- `modules/ai-code-worker/tests/unit/run-telemetry.test.ts`
- `modules/ai-code-worker/tests/e2e/otel-cli.test.ts`
- `validation/benchmark/pilot/BENCH-09-LIVE-RESULT.json`
- `validation/benchmark/P5-BASELINE.v1.json`

## Retrospective verdict

**INCONCLUSIVE**. The zero-leakage control has targeted automated evidence, while
the overhead, coverage, and functional non-regression thresholds do not have the
preregistered paired measurements required by the implementation plan. The rejected
BENCH-09 attempt is preserved and does not become a PASS after the scheduler fix.

The authorized BENCH-P rerun remains outstanding. After it establishes a valid P5
baseline, run a frozen baseline-versus-OpenTelemetry-candidate experiment with an
explicit eligible-event denominator and paired timing instrumentation before deciding
`ACCEPT`, `REJECT`, or `ACCEPT_WITH_LIMITS`.
