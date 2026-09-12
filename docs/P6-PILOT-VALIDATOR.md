# P6 pilot evidence validator

`npm run p6:pilot:validate -- --manifest <pilot-evidence.json>` validates a proposed
consumer-pilot evidence manifest against the frozen preregistration. It is deliberately
an evidence gate only: it does not execute tasks, contact providers, inspect credentials,
or upload data.

The validator requires absolute non-fixture consumer repositories, independently owned
teams, bounded and scope-verified observations, paired observations, the frozen calendar
window, upgrade/rollback/incident/restore results, and the privacy boundary. A `PASS`
manifest with incomplete evidence is rejected as `PILOT_PASS_UNPROVEN`. The current
preregistration remains `NOT_STARTED` and exits with code 2.

The machine-readable contract is
`validation/p6/pilot-evidence.schema.json`. Raw conversations, provider output, and
secrets are never valid evidence fields.
