# P5 OpenTelemetry live evaluation R2

Verdict: **ACCEPT** for the frozen internal directional hypothesis.

The R2 campaign completed 20/20 valid observations and 10/10 matched pairs with
no unmatched observations, duplicate identities, missing identities, or critical
safety failures. It used Codex `gpt-5.6-luna` at `medium` effort in both arms. The
only treatment was `INFOAPEX_OTEL_ENABLED=1` in the candidate arm.

| Frozen criterion | Threshold | Observed paired result | Verdict |
| --- | ---: | ---: | --- |
| Eligible trace coverage | improvement >= 0.95 | +1.00; baseline 0.00, candidate 1.00 | PASS |
| Verified task success | regression <= 0 | 0.00; both arms 0.80 | PASS |
| Harness overhead | upper CI <= 5% | mean -1.73%; 95% CI [-6.46%, +3.00%] | PASS |
| Telemetry leakage | delta <= 0 and candidate count 0 | 0 | PASS |

Nine tasks per arm were trace-eligible. The candidate exported 126/126 expected
spans; the baseline exported 0/126. The expected-BLOCKED `negative-blocked` task
created no eligible worker trace in either arm and is not counted as missing trace
coverage.

Both arms failed the same two hidden oracles, `cross-file-config` and
`fix-boundary`, and passed the same other eight tasks. Every scope oracle passed.
The result therefore supports trace coverage without a measured functional or
scope-safety regression; it does not claim that OpenTelemetry improves coding
quality.

## Frozen identities

- Experiment: `p5-otel-candidate-r2-20260904`
- Experiment hash: `d59e69395cfc4763bc62df4c59a5a34978bd5cd415aa838eb8a673ad3cdc3c11`
- Protocol hash: `dacbfa03655da75485a197008bc93cbfbc9fe25f07d02491fbcfe63ea3815a54`
- Hypothesis hash: `1ce234bd1f5fdbb08e93a07b4adee8a7bec55774b17aca683382170e0fb06e32`
- Registered baseline hash: `aeb52bf31b7602687c585237ddf001bd7c4bd76916773abcde4be66ebaf7cd79`
- Published benchmark commit: `fa0d39c912505f27248f2ad5edcd6f60058f2a45`
- Full local report SHA-256: `6c4b81402965ad57c77c3510e28fb1f511677dad225af472544788817a4590ce`
- Full local trace-evidence SHA-256: `4b8d9574315367a9089d74f9ad589bc62ebae4b5818a7bf316706724a2265054`

Raw provider output, worker events, span records, filesystem locations, and the
authorization private key are not published. The compact JSON result contains
only aggregate/redacted evidence and hashes.

## Calibration and limitations

R2 lasted 13 minutes 38 seconds versus the post-canary estimate of approximately
11 minutes. The planned R2 budget was exactly 20 provider invocations and R2 used
20. The earlier fail-closed R1 canary used two additional invocations, producing a
10% total invocation-count drift from the initial 20-call estimate. Worker reports
returned null for the 5-hour and weekly utilization gauges, so percentage drift
cannot be stated honestly; the preregistered estimates remain 15 and 4 percentage
points respectively.

This is a single-provider directional experiment, not a universal product ranking.
The elapsed-time overhead estimate includes provider variance, making it noisy but
conservative. The frozen upper confidence bound still remained below the 5% gate.
