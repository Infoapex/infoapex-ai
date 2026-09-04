# P4.5 / BENCH implementation report

Status: integrated and published standalone; R5 pre-P5 baseline established and
the first P5 OpenTelemetry candidate accepted internally on 2026-09-04.

Completion update: the separately frozen and authorized BENCH-09 R5 experiment
completed 30/30 valid observations, ten paired comparisons, and zero critical
safety failures. `P5-BASELINE.v2.json` records the new baseline without modifying
the rejected v1 experiment or register. Its report is `INCONCLUSIVE` only because
no P5 candidate hypothesis was attached. A separate frozen and authorized R2
experiment subsequently evaluated OpenTelemetry without rewriting this baseline.

`ai-code-benchmark` is integrated as the sixth bundle module. The root command
`infoapex-ai benchmark <subcommand> [...args]` delegates to its built CLI without
importing benchmark runtime code or translating its public subcommands.

Local release coverage includes package setup/build, its deterministic test suite,
and the hermetic BENCH-D harness (12 tasks x 3 arms). BENCH-D validates the harness;
it is not evidence of provider value and is not a live P5 baseline.

The first authorized BENCH-P experiment completed all 30 observations, but its final
immutable verdict is `REJECT`: four critical findings are attributed to a benchmark
timeout/cleanup race. The scheduler fix is covered by regression testing and cannot
retroactively repair the recorded experiment. `P5-BASELINE.v1.json` records the
historical result as `NOT_ESTABLISHED`; its required fresh rerun is the completed
R5 experiment now registered by `P5-BASELINE.v2.json`.

## Provenance and publication gate

The standalone `Infoapex/ai-code-benchmark` repository is published on `main`.
Accordingly `modules/provenance.json` records:

- `provenanceStatus: published`;
- `sourceCommit: fa0d39c912505f27248f2ad5edcd6f60058f2a45`;
- `syncMode: generic-bundle-projection` with no bundle adaptations.

The published pin does not by itself make an authoritative live benchmark or P5
acceptance claim. The mandatory P5 hypothesis template is in
`modules/ai-code-benchmark/templates/`; OpenTelemetry's retrospective threshold
assessment is explicitly `INCONCLUSIVE` in `p5-candidates/opentelemetry-redacted-v1/`.
The independent `opentelemetry-redacted-v2` hypothesis was frozen before provider
execution and R2 used a fresh experiment and Ed25519 authorization. It completed
20/20 valid observations and received `ACCEPT`: coverage `0 → 1`, zero detected
leakage, zero paired success regression, and a +3.00% upper overhead confidence bound
against the +5% gate. This is an internal directional result, not a product ranking.
