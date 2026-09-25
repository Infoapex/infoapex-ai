# Task - 2026-09-25 - IA-CONTROL-02 unified refresh

## Goal
Make refresh cover configured Rust and Python scopes, record successful multi-indexer freshness, and expose syntax-aware impact provenance.

## Changes
- Added generic `indexing.languages` scope configuration and per-run `--language-scope` overrides.
- Unified incremental and full refresh across the legacy code indexer, Rust, and Python; changed files update, deleted files prune, and unchanged Rust/Python scopes preserve graph rows.
- Scoped legacy reference and edge rebuilds to its own languages so Rust unresolved references and edges survive refresh.
- Added rebuildable `unified_refresh_runs` cache records for completion time, mode, commit when available, indexers, and scopes; health exposes the latest successful run.
- Added machine-readable impact provenance: analysis mode, semantic completeness, unresolved-reference count for Rust, risk scope, and language.
- Added a multi-crate Rust/Python/legacy-language CLI fixture testing refresh, edit, deletion, idempotence, health, and provenance.

## Validation
- `dotnet restore AiCodeControl.sln`: passed.
- `dotnet build AiCodeControl.sln --no-restore`: passed.
- `dotnet test AiCodeControl.sln --no-restore`: 118 passed.
- Root `npm test`: 81 passed.
- Transitive NuGet vulnerability audit: no vulnerable packages.
- `verify-changed-files` with the IA-CONTROL-02 manifest: passed.
- CopyBot pilot: ReadyBatch 26 affected symbols, EvidenceRepository 23; WalletFeatureSnapshot found; health records code, Rust, and Python scopes. CopyBot has no Git HEAD, so commit is null.

## Remaining limits
Rust impact is syntax-aware and partial; unresolved references stay explicit. The SQLite graph and run records are rebuildable caches. No CopyBot application source was changed. No ai-code-worker or CB-004 work was started.
