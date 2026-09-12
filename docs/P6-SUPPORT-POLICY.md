# P6 support policy

The `core-local` profile is local-first: external actions are disabled, raw
conversations are never stored, and telemetry export is off by default and by policy.
There is no automatic upload, remote support channel, or fallback provider in this
profile. An operator may explicitly create a local support bundle with `diagnostics
bundle`; the operator remains responsible for reviewing its hash and using an approved
transfer mechanism if sharing is authorized.

Support evidence is bounded and redacted. A bundle is a new regular file inside the
target repository, rejected if its path is absolute, traverses out of the repository,
crosses an unsafe/symlinked parent, already exists, or exceeds 256 KiB/the policy cap.
It carries a SHA-256 and states that transcripts, configuration values, environment
variables, provider output, and secrets are excluded. Support requests must use stable
codes and hashes rather than raw logs.

Local evidence is retained for the policy's 30-day default. `production retention` is
dry-run by default; deletion needs `--apply` and refuses symbolic links. Telemetry
export cannot be enabled through a command. A request to export, upload, or retain raw
transcripts is outside the core-local support policy and requires a separately approved
profile and privacy review.

Severity and response targets are operational targets, not availability guarantees:

| Severity | Examples | Owner | Target |
|---|---|---|---|
| S1 | scope escape, suspected secret leak, destructive recovery | Security + Runtime | acknowledge immediately; contain before any new run |
| S2 | state/migration failure, sandbox failure, release rollback | Runtime | acknowledge within one business day |
| S3 | provider unavailable, retention/diagnostic failure | Operations | acknowledge within two business days |
| S4 | documentation or usability issue | Product | triage in the next planned review |

The pre-release profile supports Node.js 22 and .NET 9 on Windows, Linux, and macOS
through the declared CI matrix. Provider capability is a bounded, non-probing status;
unavailable or unsupported providers block execution instead of switching silently.
Critical security and destructive-recovery defects block release.
