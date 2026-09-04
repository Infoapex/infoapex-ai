# BENCH-09 live result

The bounded 10-task by 3-arm Codex pilot completed all 30 authorized observations
and evaluated all 30 immutable evidence snapshots. Pairing is complete (10/10
`direct` versus `full-icm` pairs), with no missing identities or duplicate runs.

The final fail-closed verdict is **REJECT**. Verified success was 20% for `direct`,
10% for `orchestrated-no-icm`, and 10% for `full-icm`; the full-ICM delta against
direct was -10 percentage points. These values are directional only and must not be
used as a product ranking.

Four critical scope findings were caused by a benchmark-infrastructure timeout
race: the outer runtime deadline captured evidence before the adapter's `finally`
path had removed benchmark-owned `.git` metadata. The evaluator behaved correctly
by failing closed, but the finding cannot be attributed to the evaluated agent.
The scheduler now waits a bounded cleanup grace period. The completed experiment is
not rewritten or silently upgraded; a fresh frozen and authorized pilot is required
to establish the P5 baseline.

Only one observation exposed complete provider token telemetry (676,121 tokens,
including cache); the other 29 are unknown, so pilot usage drift is not comparable.
The rolling five-hour account gauge also aged during the 4h38m campaign and cannot
be converted into an attributable delta.

Canonical identifiers and artifact hashes are recorded in
`BENCH-09-LIVE-RESULT.json`. Raw provider output remains private and outside version
control.
