# ai-code-benchmark

`ai-code-benchmark` is Infoapex's independent P4.5 evaluation module. It provides
strict benchmark contracts, versioned datasets and hidden oracles, canonical experiment
freezing, subprocess-bound adapters for direct Codex, direct Claude, and public
`infoapex-ai` execution, plus paired statistical reporting. Its deterministic runtime
uses a seed-balanced A/B/C observation matrix, isolated repository copies, bounded
scheduling, evaluator-only evidence, append-only recovery events, and atomic checkpoints.

The BENCH-D campaign is hermetic and reproducible. BENCH-P live execution is a separate,
explicitly authorized validation workflow under `validation/benchmark/pilot`; it never
runs in ordinary package tests or CI and never falls back to another provider or arm.

Adapters use executable-plus-argument arrays with `shell: false`, bounded timeout and
output capture, and an environment-name allowlist that drops secret-looking variables.
Their normalized results retain adapter/parser/executable versions, requested
provider/model/effort/permissions, timing, terminal process state, raw-output hash, and
nullable usage fields. Raw output is not exposed by adapter results.

The Infoapex adapter invokes only the public root CLI. It fails as `UNSUPPORTED` unless
the isolated repository's public `.ai-code-worker/config.json` explicitly matches the
requested arm: B is `contextProvider: "none"` with `contextPackage.mode: "off"`; C/D
require `contextProvider: "ai-code-control"` and `observe` or `enforce`. It neither
patches product configuration nor imports product runtime code, and it never selects a
different provider or arm as a fallback.

## Requirements

- Node.js 22 or newer

## Commands

```powershell
npm ci
npm test
npm run benchmark:deterministic -- <output-directory>
node dist/src/cli.js --help
node dist/src/cli.js init --repo <target-repository>
node dist/src/cli.js doctor --repo <target-repository>
node dist/src/cli.js validate --suite datasets/generic-v1/suite.json
node dist/src/cli.js freeze --suite datasets/generic-v1/suite.json --out experiment.json
node dist/src/cli.js run --experiment experiment.json --mode deterministic --repo <target-repository> --state-root <external-state-root>
node dist/src/cli.js resume --experiment-id <id> --repo <target-repository> --state-root <external-state-root>
```

All operational commands emit one JSON result to stdout. `doctor` probes each configured
command with bounded version/help calls and reports unsupported capabilities without
executing a task. Generic `run` and `resume` use the deterministic runtime; the bounded
live pilot remains behind its dedicated signed-authorization driver, so `--live` on the
generic CLI fails closed. Invalid input exits with code `2`; unavailable or blocked
functionality returns structured `UNSUPPORTED` with code `3`.

`benchmark:deterministic` runs BENCH-D entirely offline using the checked-in fake
subprocess adapter. It executes the 12 generic tasks across arms A/B/C, exercises
failure, timeout, quota/unsupported, scope, false-DONE, truncation, and resume paths,
and writes canonical raw artifacts plus `report.json` and `report.md` below the supplied
output directory. Verify an existing artifact directory with:

```powershell
node ../../validation/benchmark/deterministic/verify.mjs --output <output-directory>
```

## Configuration and provenance

`init` creates `<repo>/.ai-code-benchmark/config.json`. The state root is deliberately
unset until an operator supplies an explicit location outside the target repository. The
configuration records only public subprocess commands and opt-in capabilities; it never
captures a full environment or secrets.

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the independent boundary.

## Verification status

The deterministic 12-task A/B/C harness reproduces byte-identical report and raw-data
hashes across repeated runs. The first bounded live pilot remains an immutable rejected
experiment after exposing a timeout/cleanup race. The separately frozen R5 rerun
completed 30/30 valid observations with no critical safety failure; its result is in
`validation/benchmark/pilot/BENCH-09-LIVE-FINAL-RESULT.{json,md}`.

## P5 candidates and baseline

`templates/candidate-hypothesis.template.json` is mandatory for every future P5
candidate. Complete and freeze one manifest for one bounded change before its first
candidate invocation, then provide it to `report` or `compare` with `--hypothesis`.
The current bundle-level register is
`validation/benchmark/P5-BASELINE.v2.json`, which establishes the R5 pre-P5
baseline for candidate evaluation. The rejected v1 register is preserved. Every
candidate still requires a newly frozen hypothesis, experiment, and authorization;
the baseline alone makes no P5 acceptance claim.
