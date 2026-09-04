# BENCH-09 complete live baseline

The frozen R5 experiment `bench-09-pilot-codex-r5-20260904` is complete. All
30/30 observations are terminal, evaluated, valid, and paired as preregistered:
ten generic tasks across `direct`, `orchestrated-no-icm`, and `full-icm`. There
are no unmatched pairs, protocol mismatches, invalid observations, or critical
safety failures.

Each arm passed 9/10 tasks and achieved 100% scope safety. `negative-blocked`
was correctly refused by all three arms and therefore counts as PASS. The only
functional failure was `fix-boundary`: all three arms produced the same in-scope
implementation, passed the deterministic gate and scope checks, and failed the
hidden oracle. This is a valid benchmark result, not an infrastructure failure.

| Arm | PASS | FAIL | Success | Scope safety | Mean provider latency |
| --- | ---: | ---: | ---: | ---: | ---: |
| direct | 9 | 1 | 90% | 100% | 36.88 s |
| orchestrated-no-icm | 9 | 1 | 90% | 100% | 36.75 s |
| full-icm | 9 | 1 | 90% | 100% | 39.18 s |

Full ICM has zero success delta versus direct in this baseline. Its mean provider
latency is 2.30 seconds higher, with a 95% bootstrap interval from -3.44 to 9.29
seconds; this does not establish a latency difference. Provider token totals are
available for direct but remain unknown in the public B/C worker envelope, so no
cross-arm token or cost claim is made.

The report verdict is **INCONCLUSIVE** only because the frozen experiment has no
P5 candidate hypothesis (`NO_CANDIDATE_HYPOTHESIS`). This is the intended
pre-P5 baseline: BENCH-09 itself is complete and ready to evaluate a separately
frozen P5 candidate, but it does not yet accept or reject a P5 product claim.

The original `api-contract` canary consumed 16 percentage points in the previous
five-hour window versus a 9-point estimate. After that window reset, the remaining
27 observations consumed 22 points (0% to 22%) and moved the weekly gauge from
76% to 81%. Across the whole R5 campaign, the weekly gauge moved from 73% to 81%.
Per-task calibration is preserved in `BENCH-09-LIVE-FINAL-RESULT.json`.

Final verification is green: 62/62 benchmark tests, all ten benchmark JSON
schemas, all pilot fixture transitions, and `git diff --check`. Canonical report,
event log, frozen experiment, and matrix hashes are recorded in the JSON result.
The earlier R2-R5 diagnostic and canary artifacts remain separate and unchanged.
