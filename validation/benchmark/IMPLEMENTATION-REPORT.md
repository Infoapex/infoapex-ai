# P4.5 / BENCH implementation report

Status: local integration candidate; R5 pre-P5 baseline established for candidate
evaluation on 2026-09-04. Standalone publication remains open.

Completion update: the separately frozen and authorized BENCH-09 R5 experiment
completed 30/30 valid observations, ten paired comparisons, and zero critical
safety failures. `P5-BASELINE.v2.json` records the new baseline without modifying
the rejected v1 experiment or register. Its report is `INCONCLUSIVE` only because
no P5 candidate hypothesis was attached; candidate acceptance remains a separate
future experiment.

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

There is no standalone public `Infoapex/ai-code-benchmark` commit available at this
point. Accordingly `modules/provenance.json` records:

- `provenanceStatus: local-candidate-unpublished`;
- `sourceCommit: null`;
- the required external gate: commit, test, merge and publish the standalone module
  on `main`, then replace `null` with the public 40-character SHA.

No claim of a published pin, authoritative live benchmark, or P5 acceptance follows
from this local integration. The mandatory P5 hypothesis template is in
`modules/ai-code-benchmark/templates/`; OpenTelemetry's retrospective threshold
assessment is explicitly `INCONCLUSIVE` in `p5-candidates/opentelemetry-redacted-v1/`.
A preregistered P5 candidate hypothesis plus a fresh, authorized candidate
experiment remain required for an actual P5 acceptance or rejection verdict.
