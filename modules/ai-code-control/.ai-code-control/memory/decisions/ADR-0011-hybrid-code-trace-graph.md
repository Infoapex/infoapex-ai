# ADR-0011 - Hybrid code and trace graph architecture

**Status:** Accepted
**Date:** 2026-08-28

## Context

AI Code Control already has three useful structures with different semantics:

- versioned Markdown plus SQLite FTS for durable decisions and text discovery;
- a rebuildable SQLite code graph for symbols, references, and impact analysis;
- an Obsidian Markdown/Canvas export for human navigation.

ICM added stable criterion, gate, evidence, context-package, and source-map identifiers.
The remaining gap is authoritative multi-hop trace queries such as why a rule exists,
which evidence verified a criterion, and which decision is current. The measured GRAPH-00
baseline answers 20 of 25 questions through FTS or the code graph, while all five trace
questions remain unsupported.

## Decision

Use a hybrid architecture in the existing SQLite cache:

1. Keep the execution DAG in AI Code Worker.
2. Keep the current `edges` table as the code-edge store for compatibility.
3. Add separate `trace_nodes` and `trace_edges` tables. Do not store heterogeneous trace
   entities in the code-edge table.
4. Derive stable node IDs from a namespace and canonical reference, never a display title.
5. Store source hash, source commit, ingest run, provenance, and `valid_from`/`valid_to`.
   Current queries return only open validity intervals; history remains queryable.
6. Classify relationships as T0 deterministic, T1 declared, or T2 inferred. Only T0 and
   policy-approved T1 edges may affect routing, invalidation, authorization, or verdicts.
   T2 is advisory and excluded from authoritative queries by default.
7. Route plain-text discovery to FTS, symbols and blast radius to the code graph, and
   why/current/criterion/evidence questions to the trace graph. Unsupported routes fail
   explicitly instead of silently returning approximate FTS matches.
8. Keep Obsidian as a batch, human-oriented projection. Agents and enforcement never read
   the vault as a source of truth.
9. Do not introduce GraphRAG, embeddings, Neo4j, or another graph database without a
   benchmark and a later ADR showing that SQLite and deterministic queries are inadequate.

The initial trace edge vocabulary is `supersedes`, `depends_on`, `implements`,
`verified_by`, `derived_from`, `changes`, `references`, and `selected_for`. Every edge
type has at least two accepted use cases in `docs/GRAPH-QUERY-AUDIT.md`. Automatic
`caused` edges are prohibited.

## Security and trust

- Store repository-relative canonical refs and bind every query to repository and scope.
- Treat stale hashes, commits, or validity intervals as diagnostics or fail-closed errors.
- Preserve ambiguity rather than resolving the first matching symbol or title.
- Require origin and evidence/provenance for every trace edge.
- Prevent inferred T2 edges from entering enforcement paths.
- Bind runtime evidence to manifest/source-map digest, run, and commit to prevent replay.
- Keep versioned Markdown, contracts, code, and runtime evidence canonical; SQLite and
  Obsidian remain rebuildable derivatives.

## Consequences

- Multi-hop trace queries become possible without replacing proven code and memory tools.
- Code indexing and trace ingestion can evolve independently and be rebuilt independently.
- Temporal history and provenance add schema and query complexity, but only in the layer
  that needs it.
- Obsidian can later visualize both graphs without becoming an authorization dependency.
- The next implementation stage is GRAPH-01: temporal schema, migrations, stable IDs,
  repository API, vocabulary validation, and deterministic rebuild tests.

## Evidence

- `docs/GRAPH-QUERY-AUDIT.md`
- `tools/ai-code-control/src/AiCodeControl.Core/Services/DatabaseInitializer.cs`
- `tools/ai-code-control/src/AiCodeControl.Core/Services/SymbolQueryService.cs`
- `tools/ai-code-control/src/AiCodeControl.Core/Services/ObsidianExportService.cs`
- `.ai-code-control/memory/decisions/ADR-0004-vector-search-not-refactor-truth.md`
- `.ai-code-control/memory/decisions/ADR-0006-markdown-is-canonical-memory.md`
