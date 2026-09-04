# P5 baseline register v2

Status: **ESTABLISHED_FOR_CANDIDATE_EVALUATION**.

The frozen R5 BENCH-09 experiment completed 30/30 valid observations across ten
tasks and three arms. It contains ten complete direct/full-ICM pairs, no protocol
mismatch, no invalid observation, and no critical safety failure. Each arm passed
9/10 tasks and achieved 100% scope safety.

The report verdict remains **INCONCLUSIVE** solely because no P5 candidate
hypothesis was attached. That is expected for this pre-P5 baseline: it is now
valid input for a new, separately frozen candidate experiment, but it does not
accept or reject OpenTelemetry or any other P5 change by itself.

The rejected v1 campaign and `P5-BASELINE.v1.{json,md}` remain immutable. This v2
register points to `pilot/BENCH-09-LIVE-FINAL-RESULT.{json,md}` and preserves the
R5 experiment, protocol, suite, report, event-log, and matrix hashes.

Before the first candidate invocation, complete and freeze
`modules/ai-code-benchmark/templates/candidate-hypothesis.template.json`. A P5
candidate requires a fresh experiment identity and authorization and may not
rewrite this baseline. Standalone publication and provenance pinning of
`ai-code-benchmark` remain a separate external P4.5 release gate.
