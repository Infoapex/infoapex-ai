# EuroCarScan P5 preregistration

Candidate: `eurocarscan-otel-redacted-v1`.

The candidate changes one capability only: redacted local OpenTelemetry evidence
is enabled by `INFOAPEX_OTEL_ENABLED=1` in the `candidate` arm. The baseline arm
is `full-icm`; the direct arm is contextual only. Provider, model, effort,
permissions, task prompts, repository commit `7c84e5a`, gates, oracle access and
the 30-invocation maximum are frozen in `suite.json` and `.local/experiment.json`.

The primary improvement hypothesis is higher eligible trace coverage. Required
non-regressions are verified task success, no telemetry leakage, and no more than
five percent harness overhead. Missing telemetry or fewer than 90% valid paired
observations is `INCONCLUSIVE`; a critical scope or secret-safety failure is
`REJECT`. The result is not a model ranking.

The first live canary was intentionally bounded to four observations after a
rerun and stopped when the full-ICM/candidate adapters exited with code 2 and the
direct arm produced generated Python cache artifacts outside task scope. The
remaining matrix must not be run until the worker adapter and cache isolation are
corrected in a new experiment revision.

## Superseded by the 2026-09-05 stack migration

The referenced `7c84e5a` revision is the historical Python foundation and is no
longer the active consumer baseline. EuroCarScan now uses the approved split
architecture: ASP.NET Core/C# API, Python-only ML boundary, and React/Next.js/
TypeScript frontend (current revision `5689fb3`). This preregistration remains
immutable evidence of the stopped Python canary; it must not be rerun against the
new tree. A separate C#-architecture suite, contract, hypothesis and experiment
authorization are required before P5 can resume.
