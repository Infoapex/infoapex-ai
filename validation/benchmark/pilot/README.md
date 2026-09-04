# BENCH-09 / BENCH-P

This directory is the frozen, generic pilot surface. It contains exactly ten small
task manifests and evaluator-only oracle files. `repos/` is generated locally by
the self-contained builders and is ignored by version control.

The preregistered matrix is one provider (`codex`) across `direct`,
`orchestrated-no-icm`, and `full-icm`, with `gpt-5.6-luna`, medium effort, one
balanced repetition, and exactly 30 invocations maximum. The 90% validity gate,
protocol hash, task hashes, explicit no-fallback rule, and non-authoritative
limitations are written into the frozen experiment produced by preflight.

Preflight executes the benchmark-owned gates and hidden oracles before and after the
known solution for all nine positive fixtures, validates the expected-blocked secret
oracle, and probes the real Codex help/version, public root help, and ai-code-control
health/context commands without starting a provider task. Live execution additionally
requires an Ed25519-signed local authorization file matching the frozen experiment.
Raw provider material remains private; only redacted report artifacts are distributable.

Live configuration is deliberately not produced by `init`: the default remains
fail-closed. An operator must create a config with `capabilities.liveExecution: true`,
the four fixed command arrays (`codex`, `claude`, `infoapex`, `aiCodeControl`), and the
complete `pilot` contract below. `sharedConfigHash` is emitted by fake preflight and
verify; for this frozen revision it is
`2f592a5a4f1009d9fbeb9d0bba0e08ff61a46e6ffd4116c17499985c3216a2fc`.

```json
{
  "schemaVersion": "1.0",
  "stateRoot": null,
  "commands": {
    "codex": ["codex"],
    "claude": ["claude"],
    "infoapex": ["node", "C:/absolute/infoapex-ai/dist/src/cli.js"],
    "aiCodeControl": ["dotnet", "C:/absolute/AiCodeControl.Cli.dll"]
  },
  "capabilities": {
    "liveExecution": true,
    "networkExpansion": false,
    "publish": false,
    "secretForwarding": false
  },
  "pilot": {
    "schemaVersion": "bench-09-live.v1",
    "trustedFixtureOnly": true,
    "maximumInvocations": 30,
    "equalBudgets": true,
    "sharedConfigHash": "2f592a5a4f1009d9fbeb9d0bba0e08ff61a46e6ffd4116c17499985c3216a2fc",
    "arms": {
      "orchestrated-no-icm": { "contextProvider": "none", "contextPackageMode": "off" },
      "full-icm": { "contextProvider": "ai-code-control", "contextPackageMode": "enforce" }
    }
  }
}
```

Typical local harness checks:

```text
npm run benchmark:pilot:preflight
npm run benchmark:pilot:verify
```

The live command is intentionally not part of CI and must be invoked explicitly
with `--authorization`, `--experiment`, `--config`, and `--state-root`. The harness
ignores arbitrary target contents and rebuilds the hash-frozen trusted fixtures for
every campaign. Each B/C observation gets the same evaluator-generated accepted
worker v1.1 plan, prompt, criteria, and budgets; the only treatment difference is
the public worker context setting. Benchmark-owned Git/config scaffolding is removed
or restored before evaluator diff capture.

For a fail-fast infrastructure canary, pass
`--maximum-new-observations 3`. A subsequent explicit invocation can use `--resume`
with the same bound. Existing terminal observations do not consume the per-invocation
allowance, and an incomplete matrix remains `INTERRUPTED`/`INCONCLUSIVE`.

The completed pre-P5 live baseline is recorded in
`BENCH-09-LIVE-FINAL-RESULT.{json,md}`. Its frozen R5 matrix has 30/30 valid
observations, ten direct/full-ICM pairs, and no critical safety failure. The
report remains non-authoritative and INCONCLUSIVE only because no P5 candidate
hypothesis was preregistered. The earlier
`BENCH-09-LIVE-RERUN-R5-RESULT.{json,md}` remains the immutable 3/30
infrastructure canary.

Residual live limitations: the harness relies on Codex's own `workspace-write`
sandbox for provider writes and on trusted-fixture allowlisting for gate commands;
it does not independently prove host-level network denial. ai-code-control must be
initialized and healthy for arm C. These conditions make preflight `BLOCKED`; they
must not be waived or silently mapped to another arm.

For this local bundle, `node prepare-live.mjs` builds a machine-local configuration,
performs the real no-provider preflight, freezes the experiment, and creates a
short-lived authorization derived from the explicit user request. Generated files
remain under ignored `.local/`; the private signing key is never written to disk.
An explicitly approved continuation of the same frozen experiment can use
`renew-live-authorization.mjs --experiment <path>` to create a new, separately
signed, non-overwriting authorization; it never refreezes the experiment or
rewrites terminal observations.
