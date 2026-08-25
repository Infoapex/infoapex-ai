# Runtime Source

Runtime code starts in Phase 0.

Expected module layout:

- `cli` - commands, JSON output, exit codes.
- `core` - state machine and DAG scheduler.
- `manifest` - schema loading, normalization, freeze hashing.
- `policy` - path, command, budget, and engine compatibility rules.
- `pilot` - preregistered pilot value-gate evaluation.
- `git` - preflight, worktree, diff, staging, worker-owned commit, integration.
- `runner` - quality-gate config, child processes, timeout, cancellation, redaction.
- `validation` - task gates, global gates, evidence mapping.
- `review` - read-only reviewer contract, criterion coverage, and finding handling.
- `persistence` - event log, snapshots, rebuildable indexes.
- `engines` - Codex CLI, Claude, and fake adapters.
- `context` - optional ai-code-control provider through CLI JSON.
