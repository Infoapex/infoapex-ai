# AI code benchmark threat model

## Assets and trust boundaries

The protected assets are target repositories, hidden oracles, provider credentials,
raw prompts/outputs, usage records, experiment configuration, and verdict integrity.
The benchmark controller and evaluator are trusted for experiment administration.
Provider CLIs, Infoapex arms, task repositories, generated patches, and imported
intervention logs are untrusted inputs. Subprocess JSON is data, never executable
configuration.

## Threats and controls

| Threat | Control | Failure result |
|---|---|---|
| Oracle leakage to an agent | Oracles are evaluator-only and mounted/read after execution | observation invalid |
| Cross-arm contamination | fresh isolated repository per observation; no shared writable state | observation invalid |
| Path traversal or junction escape | canonical containment checks before every write/evaluation | blocked |
| Command injection | executable plus argument arrays; no task-controlled shell fragments | blocked |
| Secret leakage | environment allowlist, value redaction, private raw-artifact root | redacted/blocked |
| Self-grading or false `DONE` | benchmark-owned gates and diff inspection override agent claims | fail |
| Selective reporting | append-only event log and declared observation matrix | incomplete/inconclusive |
| Usage double counting on resume | stable observation IDs and cumulative-to-delta normalization | invalid metric |
| Benchmark gaming | hidden variants, frozen protocol hash, balanced order, blinded optional review | report limitation |
| Provider/version drift | capture executable, version, model, effort, permissions, and environment hash | split/inconclusive |
| Destructive or network side effects | workspace sandbox and explicit capability allowlist | blocked |
| Malicious report content | escaped Markdown, canonical JSON, no HTML execution | redacted/blocked |

## Security invariants

The target path must resolve below the allocated observation root. Symlinks and
junctions that escape it are rejected. The harness never publishes commits, opens a
PR, or enables additional network access implicitly. Logs must not contain values of
environment variables whose names match secret/token/key/password patterns. Cleanup
is restricted to a previously recorded, canonical observation directory.

Security failures are never averaged into a score. A critical escape, secret leak,
or unauthorized external side effect makes the experiment `REJECT` regardless of
quality gains.

