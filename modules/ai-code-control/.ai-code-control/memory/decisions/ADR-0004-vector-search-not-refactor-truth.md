# ADR-0004 - Vector search is NOT refactor truth

**Status:** Accepted
**Date:** 2026-04-30

## Context

Vector/semantic search (Qdrant, Chroma, FAISS) could be used for symbol lookup or impact analysis.

## Decision

Vector search is **not** used as the source of truth for refactor decisions. It may be added later as a discovery aid only.

The authoritative source of truth for "what breaks if I change X?" is the structural code graph: symbols, references, import edges, call edges stored in `codegraph.sqlite`.

Memory FTS5 (`memory.sqlite`) is a text-search index over markdown notes — it provides context, not code facts.

## Consequences

- Refactor scope is determined by `impact-analysis` (graph query), not semantic similarity.
- Memory search (`memory-search`) returns relevant decisions/tasks for context, not code references.
- No vector DB dependency in MVP. Can be added optionally later without changing the core refactor workflow.

## Formula

```
memory-brief     = context (what we decided and why)
impact-analysis  = code truth (what will break)
run-validation   = functionality truth (tests/lint)
git diff         = modification truth (what changed)
```
