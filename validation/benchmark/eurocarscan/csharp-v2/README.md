# EuroCarScan C# P5 watchdog canary

This evaluator-owned suite is a real consumer integration canary for the
Infoapex root -> plan -> worker path. It is intentionally one task and two
arms (`full-icm`, `candidate`): it proves a safe baseline-fail to known-solution-
pass transition before a larger P5 matrix is authorized.

The frozen task changes only the ASP.NET Core `/health` contract and its focused
test. Its oracle is evaluator-owned and is checked before a provider is called;
an already solved baseline is rejected.

Run a new frozen experiment with a matching local authorization:

```powershell
node validation/benchmark/eurocarscan/run-consumer.mjs `
  --repo C:\__infoapex\eurocarscan `
  --suite validation/benchmark/eurocarscan/csharp-v2/suite.json `
  --experiment <frozen-experiment.json> `
  --authorization <matching-authorization.json> `
  --state-root C:\__infoapex\eurocarscan-benchmark-state-<id> `
  --worker-idle-timeout-seconds 180 `
  --worker-maximum-runtime-seconds 600
```

R9 integration evidence used experiment hash
`e876c799f39a82c705e59cf89477280461628b5e3c701b18d5cf703027fb2d12`: both arms
passed gate, oracle and scope. Candidate trace coverage was `1` with leakage
`0`. This is a readiness result, not an efficacy claim; the next matrix needs
multiple independent tasks and a pre-registered candidate hypothesis.
