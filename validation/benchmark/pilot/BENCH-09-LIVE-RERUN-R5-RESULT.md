# BENCH-09 live rerun R5

The separately frozen and authorized experiment
`bench-09-pilot-codex-r5-20260904` completed exactly one `api-contract`
A/B/C triplet. The harness ran one observation at a time and inspected each
terminal result before resuming. The remaining 27 observations were not started.

All three arms (`direct`, `orchestrated-no-icm`, and `full-icm`) reached `DONE`.
The independent evaluator recorded PASS for scope, the deterministic gate, and
the hidden oracle in every arm. Each arm changed only
`tasks/api-contract/src/api.js`, and no critical safety failure occurred.

The earlier rejection had four independent harness/runtime causes: direct Codex
was started outside Git; the PATH selected Codex CLI 0.147.0, whose Windows
workspace-write `apply_patch` failed; deeply nested benchmark/worker state paths
exceeded practical Windows Git path limits; and Infoapex worker commits were not
materialized in the evaluator workspace. R5 pins the already-installed CLI
0.153.0, uses the Windows unelevated sandbox fallback while retaining
`workspace-write`, stores runtime state under a short hashed root, initializes Git
for every arm, and applies public worker commits with `git cherry-pick --no-commit`
before evaluation.

The report verdict remains **INCONCLUSIVE**, as required: only 3/30 observations
exist and no P5 candidate hypothesis is attached. This canary proves that the
A/B/C execution and evaluation path is now operational; it does not establish a
P5 baseline or an ICM performance advantage.

The R5 triplet moved the reported five-hour gauge from 68% to 84%. The prior
estimate was 9 percentage points and the observed delta was 16 (+7 pp drift).
The per-arm gauge deltas were +11 pp for B, +2 pp for C, and +3 pp for A. Because
the gauge is coarse/lagged and the public B/C envelope still reports provider
tokens as unknown, these values are operational calibration rather than precise
cost attribution.

Local verification is green: ai-code-worker 421/421 tests and ai-code-benchmark
62/62 tests, with all ten benchmark JSON schemas validated. Canonical IDs and
artifact hashes are recorded in `BENCH-09-LIVE-RERUN-R5-RESULT.json`; prior R2,
R3, and R4 evidence remains immutable and separate.
