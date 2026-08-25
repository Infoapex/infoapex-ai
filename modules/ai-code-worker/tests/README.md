# Tests

Phase 0 should add deterministic tests before any real engine adapter is enabled.

Required test groups:

- schema fixtures, valid and invalid;
- manifest normalization and hashing;
- path normalization on Windows and Linux;
- sync-root and Git common-directory detection;
- event replay;
- fake-engine end-to-end flow;
- Git worktree, changed-path discovery, scope verification, and worker-owned commit control;
- quality-gate config resolution and real gate execution in task/global runner paths;
- read-only review and criterion coverage matrix enforcement;
- scope path policy for task-owned changes;
- usage evidence with cached and uncached token split;
- pilot value-gate evaluation.
