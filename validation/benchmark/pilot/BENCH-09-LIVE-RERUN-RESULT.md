# BENCH-09 live rerun result

The newly frozen and separately authorized experiment
`bench-09-pilot-codex-r2-20260904` was run as a three-observation A/B/C canary.
The harness stopped before the remaining 27 observations, as required by the
early-stop policy.

All three `api-contract` arms were terminal and evaluated, but each provider
subprocess exited unsuccessfully before changing the isolated workspace. The
observed provider latencies were 2,111 ms for `orchestrated-no-icm`, 2,651 ms for
`full-icm`, and 752 ms for `direct`. All three evaluations failed, all three scope
checks passed, and no critical safety finding occurred.

The common failure across direct and orchestrated arms classifies this as a
provider-entry-layer failure rather than an ICM-only failure. The precise upstream
reason is not recoverable from distributable evidence: provider stderr remains
private by design and the current execution snapshot retains the normalized message
but not the adapter exit code. Account quota, provider admission, and another Codex
CLI startup rejection therefore remain possible causes and must not be guessed into
the result.

The report verdict is **INCONCLUSIVE** because only 3/30 observations were run.
Three of 30 authorized invocations were attempted (10%); 27 were avoided. Provider
token usage is unknown for all three attempts, so token drift is not measurable.
This rerun does not establish the P5 baseline.

Canonical identifiers and artifact hashes are recorded in
`BENCH-09-LIVE-RERUN-RESULT.json`. The original completed BENCH-09 result remains
immutable and separate.
