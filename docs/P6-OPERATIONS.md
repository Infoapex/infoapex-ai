# P6 core-local operations

Readiness: run `infoapex-ai preflight`, `config validate`, and `production doctor`.
Supported terminal states are explicit PASS/BLOCKED; an absent report is not success.

Incident order: stop new runs, preserve the lease/state, create a redacted diagnostics
bundle, verify the migration backup, classify provider/policy/deterministic failure,
then recover without widening permissions or changing provider. Rollback must use its
verified journal. Diagnostics are local and never uploaded automatically.

Initial SLOs: 100% explicit terminal state; zero scope escapes and secret leaks; 99%
eligible trace completeness; at least 95% simulated recovery without manual repair.
