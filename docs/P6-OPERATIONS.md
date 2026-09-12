# P6 core-local operations

## Health, readiness, and evidence

Run `infoapex-ai production health --repo <path>` for a bounded, non-probing health
record. Its only statuses are `PASS`, `UNKNOWN`, and `BLOCKED`; it reports root policy,
each configured module, provider policy, and isolation backend separately. `UNKNOWN`
means a provider or sandbox was deliberately not invoked, not that it is healthy. The
record contains no configuration values or raw process output.

Run `infoapex-ai production doctor --repo <path>` before acquiring a lease. A doctor
result is `PASS` or `BLOCKED`; it fails closed for an invalid local policy or an active/
stale lease. Use `preflight` and `config validate` for installation validation.

`infoapex-ai diagnostics bundle --repo <path> [--out <relative-path>]` is an explicit,
local operator action. It writes a new repository-contained JSON artifact, refuses
absolute, traversal, symlinked, or existing targets, caps output at 256 KiB (and the
lower policy limit), and returns its SHA-256. The bundle has no upload code or endpoint.
It contains only health state, telemetry aggregates, basic runtime identity, and a
redaction manifest; it never contains configuration values, environment variables,
source files, transcripts, secrets, or provider process output.

Telemetry export is permanently `off` in the core-local policy. Local telemetry is read
only from `.infoapex-ai/telemetry/events.jsonl`, with a 1 MiB input cap and a four-field
event contract. `TELEMETRY_NO_LOCAL_EVIDENCE`, `TELEMETRY_SIZE_LIMIT`, and
`TELEMETRY_INVALID` are actionable diagnostics, never silent success. See
`P6-SLO.md` for rules and owners.

Evidence retention is local and explicit: `infoapex-ai production retention --repo <path>`
only inventories expiry. Adding `--apply` deletes expired regular files in the local
diagnostics and telemetry directories. It refuses unsafe roots and symbolic links. The
policy default is 30 days; no evidence is exported during retention.

## Incident runbooks

For every incident: stop new runs, preserve the lease and state, record the bounded
decision code, and create a redacted bundle only if an operator needs to share evidence.
Do not delete runtime state, widen permissions, change provider, or upload evidence.

### Provider unavailable

1. Confirm `PROVIDER_NOT_PROBED` or the provider's stable failure code; do not paste raw
   provider output into tickets.
2. Mark the run `BLOCKED`; do not silently select a fallback provider.
3. Restore service or obtain an approved provider-policy change, then start a new run.

### Migration or state failure

1. Stop writers and retain the migration journal, backup, manifest, and lease.
2. Run `config validate` and `migrate --check`; malformed state is `BLOCKED`.
3. Use the verified `rollback --migration config-v1` path. Never manually edit a journal.

### Sandbox/isolation failure

1. Record `ISOLATION_NOT_PROBED`, `ISOLATION_CONFIG_INVALID`, or the stable backend code.
2. Verify the isolation config and permitted workspace from outside the failing run.
3. Correct the approved configuration and rerun preflight; do not bypass isolation.

### Scope or security incident

1. Stop all runs and revoke affected credentials outside Infoapex if exposure is possible.
2. Preserve minimal local evidence; classify `scope` or `leakage` as severity 1.
3. Do not upload a bundle until security approves a separate transfer channel. Rotate,
   investigate, and add a regression test before resuming.

### Disk exhaustion

1. Stop new work before state writes fail; retain the last valid manifest and lease.
2. Run retention in dry-run mode, obtain approval, then use `--apply` only for expired
   local evidence. Never delete active runtime state to make room.
3. Recover capacity, validate configuration/state, and use normal stale-lease recovery.

### Release rollback

1. Stop promotion and identify the recorded upgrade id.
2. Run `rollback --release --upgrade-id <id> --dry-run`, inspect the bounded result, then
   rerun without `--dry-run` only if its backup is verified.
3. Re-run `install --check`, `preflight`, and `production doctor`; attach hashes, not
   raw logs, to the release incident.

## P6.4 recovery boundary

Only recover a parseable lease older than the policy stale limit. Recovery moves it to
`.infoapex-ai/runtime/recovery/` and records `STALE_LEASE_RECOVERED` before a new lease
is acquired. An active or malformed lease is blocked and is never removed manually.
