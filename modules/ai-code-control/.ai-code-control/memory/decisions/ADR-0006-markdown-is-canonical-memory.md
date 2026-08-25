# ADR-0006 - Markdown files are the canonical memory store

**Status:** Accepted
**Date:** 2026-04-30

## Context

Multiple options exist for storing persistent context: SQLite, vector DBs, external services (MemPalace, claude-mem), raw conversation dumps.

## Decision

Markdown files versioned in git are the canonical memory store. `memory.sqlite` is a search index derived from them, not the source of truth.

Versioned under git:
- `AGENTS.md`, `CLAUDE.md`, `REFACTOR_POLICY.md`
- `.ai-code-control/config/code-control.json`, `memory-control.json`
- `.ai-code-control/memory/project-memory.md`
- `.ai-code-control/memory/decisions/*.md`
- `.ai-code-control/memory/tasks/*.md`
- `.ai-code-control/memory/summaries/*.md`

Excluded from git:
- `.ai-code-control/db/` (generated, rebuild with `memory-ingest`)
- `.ai-code-control/reports/` (generated reports)

## Consequences

- If `memory.sqlite` is deleted, run `memory-ingest` to rebuild from markdown sources.
- All memory mutations go through markdown files first, then `memory-ingest`.
- Raw conversation dumps are never stored (noisy, may contain secrets).
- External memory tools (MemPalace, claude-mem) are optional supplements, not replacements.

## Related files

- `.ai-code-control/config/memory-control.json` (`include`, `exclude` patterns)
- `tools/ai-code-control/src/AiCodeControl.Memory/Services/MemoryIngestService.cs`
