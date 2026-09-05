# EuroCarScan P5 preregistration — C# architecture

Candidate: `eurocarscan-otel-redacted-csharp-v1`.

This is a new experiment after the Python prototype was retired. The frozen
consumer revision is the ASP.NET Core/C# backend, Python-only ML boundary and
React/Next.js/TypeScript frontend baseline (`d8aaa37`). The candidate changes one
capability only: redacted local OpenTelemetry evidence enabled by
`INFOAPEX_OTEL_ENABLED=1`; direct and full-ICM arms remain otherwise constant.

The primary hypothesis is higher eligible trace coverage. Required
non-regressions are verified task success, zero telemetry leakage and no more
than five percent harness overhead. Missing telemetry or fewer than 90% valid
paired observations is `INCONCLUSIVE`; a critical scope or secret-safety failure
is `REJECT`. This is a preregistration, not an acceptance result. A fresh
authorization must be generated from the suite hash and experiment hash before
any provider invocation.
