# .ai-code-worker

This directory contains versioned configuration for a consumer repository.

It must not contain run state, worktrees, raw model transcripts, caches, logs, or SQLite databases. By default, runtime state is resolved to an OS-local `stateRoot` outside the consumer repository.

The default context provider is `none`. Autonomous writers use an `isolated` execution profile by default; `trusted-local` requires an explicit authorization outside repository-controlled instructions.

The future `ai-code-worker init` command should manage this directory idempotently and show a diff before changing existing user-owned files.
