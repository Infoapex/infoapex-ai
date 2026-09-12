# P6 core-local operations

Readiness: run `infoapex-ai preflight`, `config validate`, and `production doctor`.
Supported terminal states are explicit PASS/BLOCKED; an absent report is not success.
The full installer derives .NET targets and npm checks from the consumer repository,
writes MCP configuration for compatible clients, and leaves unavailable toolchains
disabled. Review `.ai-code-control/config/code-control.json` after application manifests
change, then rerun `init --full --repair` and `preflight`.

Incident order: stop new runs, preserve the lease/state, create a redacted diagnostics
bundle, verify the migration backup, classify provider/policy/deterministic failure,
then recover without widening permissions or changing provider. Rollback must use its
verified journal. Diagnostics are local and never uploaded automatically.

Initial SLOs: 100% explicit terminal state; zero scope escapes and secret leaks; 99%
eligible trace completeness; at least 95% simulated recovery without manual repair.

## P6.4 recovery runbook

Core-local recovery is fail-closed. A run has one immutable manifest hash, one explicit
provider (`fake`, `codex`, or `claude`), one repository lease, and terminal state
`DONE`, `BLOCKED`, or `CANCELLED`. Resume must retain the same run id, manifest, provider,
and policy; it never starts a replacement run or enables an external action.

Decision codes: `RUN_CONCURRENT`, `LEASE_ACTIVE`, `LEASE_INVALID`,
`STALE_LEASE_RECOVERED`, `MANIFEST_MISMATCH`, `PROVIDER_MISMATCH`,
`TASK_COMMIT_CONFLICT`, `EFFECT_OUTCOME_UNKNOWN`, `PROCESS_TIMEOUT`, `OUTPUT_LIMIT`,
`PROCESS_LIMIT`, and `CLEANUP_INTERRUPTED`. An unknown external-effect outcome is blocked,
not retried; this is the duplicate-effect boundary.

Operator-safe recovery:

1. Stop new invocations. Do not delete a lease or state file manually.
2. Run `production doctor`; retain `.infoapex-ai/runtime/lease.json` and the run's
   `state.json`, `manifest.json`, `events.json`, and `recovery-evidence.json`.
3. Only recover a parseable lease older than the policy stale limit. Recovery moves it to
   `.infoapex-ai/runtime/recovery/` and records `STALE_LEASE_RECOVERED` before acquisition.
4. Resume only with the original run id, provider, and manifest. A terminal `BLOCKED`
   result needs operator review and a new run id after correction.

Cleanup inventory is bounded to the runtime lease, stale-lease decision, run manifest,
state, event log, and recovery evidence. Cleanup interruption is itself terminal evidence;
it must not remove these files or broaden permissions.
