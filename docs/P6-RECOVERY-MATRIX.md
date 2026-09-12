# P6.4 recovery matrix

| Injection / condition | Required decision | Preserved evidence | Resume behavior |
|---|---|---|---|
| Before state commit | `INTERRUPTED_BEFORE_COMMIT` | state, manifest, bounded event log | blocked; no implicit retry |
| After state commit | `INTERRUPTED_AFTER_COMMIT` | committed task record | task/gate/effect are not repeated |
| Provider timeout | `PROVIDER_TIMEOUT` / `PROCESS_TIMEOUT` | capped output and terminal state | operator starts a new run |
| Provider rate limit | `PROVIDER_RATE_LIMIT` | terminal state and event | no provider substitution |
| Malformed provider output | `PROVIDER_OUTPUT_INVALID` | redacted bounded evidence | blocked |
| Worktree corruption | `WORKTREE_CORRUPT` | state, manifest, event | blocked pending repair |
| Concurrent repository run | `LEASE_ACTIVE` / `RUN_CONCURRENT` | current lease | second run rejected |
| Stale lease | `STALE_LEASE_RECOVERED` | moved prior lease + decision | same policy, explicit acquisition |
| Output / process budget | `OUTPUT_LIMIT` / `PROCESS_LIMIT` | capped output, terminal process result | no background child retained |
| Cleanup interruption | `CLEANUP_INTERRUPTED` | cleanup inventory and evidence | no deletion by recovery |

All state, manifest, event snapshot, and recovery-decision documents publish via
write-then-rename. Invalid or oversized documents fail closed.
