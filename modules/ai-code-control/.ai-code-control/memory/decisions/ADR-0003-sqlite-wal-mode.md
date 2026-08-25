# ADR-0003 - SQLite WAL mode for all databases

**Status:** Accepted
**Date:** 2026-04-30

## Context

Both `codegraph.sqlite` and `memory.sqlite` can be read and written concurrently (CLI + indexer).

## Decision

Enable WAL (Write-Ahead Logging) mode on all local SQLite databases:

```sql
PRAGMA journal_mode=WAL;
PRAGMA synchronous=NORMAL;
PRAGMA foreign_keys=ON;
PRAGMA temp_store=MEMORY;
```

## Consequences

- WAL allows concurrent reads during writes — no blocking.
- `NORMAL` sync is safe for local dev workloads (risk of 1 transaction loss on OS crash, acceptable).
- Both DBs use triggers to keep FTS5 index in sync with `memory_items`.
- Databases are excluded from git (`.ai-code-control/db/` in `.gitignore`).

## Related files

- `tools/ai-code-control/src/AiCodeControl.Core/Services/DatabaseInitializer.cs`
