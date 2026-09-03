# ADR 0013: A task's usage survives its own failure and survives resume

- Status: Accepted
- Date: 2026-09-03

## Context

A real consumer project (an Orders feature pilot, closed 2026-08-30) ran a 10-task
sequential Codex run that hit a rate limit mid-run. Their own pilot report says:

> "Telemetria completă a rulării nu este disponibilă: workerul a păstrat doar invocarea
> T04 oprită de cotă... Rezultatul usage este, corect, `inconclusive`... blocată până
> când adapterul Codex expune și workerul persistă usage complet pe întreaga rulare."

("Complete run telemetry is not available: the worker retained only the T04 invocation
stopped by quota... the usage result is, correctly, `inconclusive`... blocked until the
Codex adapter exposes and the worker persists complete usage across the entire run.")

Tracing this in `src/run/codex-run.ts` (and identically in `claude-run.ts`) found two
separate, previously-unflagged silent-data-loss bugs, not one:

1. **A task's own usage was discarded when that same task failed.**
   `CodexCliAdapter` parses `execution.usage` from stdout unconditionally (`codex-cli.ts`
   calls `parseCodexUsage(child.stdout)` regardless of exit code or final result), so a
   rate-limited invocation that emitted a `token_count` event before dying does have its
   partial usage available. But `codex-run.ts` only called `addUsage(usageTotals,
   execution.usage)` *after* a task fully succeeded (result match, `status === "DONE"`,
   commit, gates all passed). Every earlier `blockRunningRun` return - result mismatch,
   `ENGINE_TASK_FAILED`, commit failure, gate failure - passed the *previous* task's
   `usageTotals`, never folding in the failing task's own consumption. A task that spent
   real, billable tokens before failing had that spend erased from the run's report.

2. **Resuming a run replaced an already-finished task's real usage with nothing.**
   When recovery finds `checkpoint?.finishedCommit` for a task (it committed and passed
   gates in an earlier process invocation), the resume fast path recorded
   `addUsage(usageTotals, unknownUsage())` - an all-null placeholder - instead of the
   task's real numbers. Combined with `addUsage`'s deliberate fail-closed null
   propagation (a P2-A fix, `408f9e8`: once any field goes null, it stays null for the
   rest of the run), *one* resumed task poisons the entire run's final usage to
   `inconclusive`, discarding every other task's perfectly good numbers along with it.
   The same pattern exists in `continueFromCommittedTask` and `recoveredTerminalRun`.

A third, correctly-designed mechanism already exists for exactly this class of problem -
`src/usage/normalized-usage.ts`'s sample/series aggregator, built specifically to survive
retries and resume without losing or double-counting data (`docs/USAGE-TELEMETRY-V1.md`)
- but it was never wired into `codex-run.ts`/`claude-run.ts`'s actual accumulation path.
Only its `assessUsageTotals` helper is reused, to classify the old `UsageTotals` shape.

## Decision

Fix the two concrete bugs precisely; do not attempt the larger migration to the
sample-based aggregator in the same change.

**Bug 1 fix**: move `usageTotals = addUsage(usageTotals, execution.usage)` to
immediately after `execution` becomes available (right after the engine call returns),
before any of the result-mismatch/failure/commit/gate `blockRunningRun` early returns.
Every one of those paths now includes the current task's own usage in the `usageTotals`
it passes to `blockRunningRun`, which persists it into `run-report.json`. The later,
now-duplicate `addUsage` call on the success path is removed.

**Bug 2 fix**: a new `usageFromTaskEvidence(taskRoot)` helper reads back
`tasks/<taskId>/evidence.json` - guaranteed to exist for any task recovery marks
`finishedCommit`, since a `task.finished` event (the only thing that sets
`finishedCommit`) is only ever appended after `evidenceFor()`'s `writeJson()` call for
that task - and reconstructs the real `EngineUsage` from it. Falls back to
`unknownUsage()` only if the file is somehow missing or unparseable; never throws. The
`checkpoint?.finishedCommit` resume fast path uses this instead of `unknownUsage()`.

Both fixes are applied identically to `codex-run.ts` and `claude-run.ts` (structurally
identical code). Only `codex-run.ts` has dedicated regression tests
(`tests/unit/usage-persistence.test.ts`, using a bespoke fake Codex CLI that reports
partial usage and then dies, and a second fixture that truncates a completed run's event
log to simulate a crash right after one task finished) - `claude-run.ts` received the
same two-line change verified by code identity and the full existing suite staying
green, not a second dedicated fixture, as a deliberate scope/time trade-off given the
reported real-world incident was Codex-specific.

### Not in scope here

- `continueFromCommittedTask` (a task already `committed` but gates hadn't run yet when
  the process died) and `recoveredTerminalRun` (reconstructing an already-fully-terminal
  run) still use `unknownUsage()`. Both are narrower windows than the two fixed here -
  the former requires a crash in a few-hundred-millisecond gap between commit and gate
  completion, the latter is querying an already-closed run, not continuing one - and
  fixing them needs a different recovery source in each case (the cross-run
  `UsageCheckpointLog` for the first; re-reading `run-report.json` for the second) rather
  than a shared evidence.json read-back. Left as an acknowledged gap, not silently
  patched over, matching this project's practice of stating scope boundaries explicitly.
- Migrating to `normalized-usage.ts`'s sample-based aggregator as the run pipeline's
  actual accumulation mechanism remains open and would subsume both fixes here more
  generally - a larger, separate undertaking, not attempted in this change.

## Consequences

- A `BLOCKED` run's `run-report.json` now reflects real consumption up to and including
  the task that caused the block, not just the tasks that fully succeeded before it -
  directly closing the reported gap for the common case (a task fails or hits
  a rate limit; the run stops there).
- Resuming a run no longer poisons the entire run's usage total to null just because one
  task's real numbers had to be recovered rather than freshly computed.
- The two narrower resume paths noted above remain a known, documented limitation.
