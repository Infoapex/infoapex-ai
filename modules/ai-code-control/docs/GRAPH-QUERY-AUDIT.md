# Graph query audit (GRAPH-00)

Status: accepted baseline for GRAPH-01

Date: 2026-08-28

Profile: `codex:gpt-5.6-sol:high`

## Purpose

This audit separates three query systems instead of treating every relationship as one
graph:

- memory FTS for text discovery and prior decisions;
- the existing code graph for symbols and blast radius;
- a proposed trace graph for current decisions, criteria, tasks, gates, evidence, and
  provenance.

The Obsidian export is intentionally excluded as an agent query engine. It is a batch,
human-oriented projection of the code and trace graphs.

## Measurement method

The first 20 cases were executed against the refreshed local indexes through the built
CLI DLL. Latency is end-to-end process latency. Approximate context tokens use output
characters divided by four and are a comparison aid, not provider billing. A case has
source evidence when the response identifies a versioned source path or structural code
location. Direct answer completeness is stricter: noisy locator output counts as partial.

Trace cases are a deliberate gap baseline. No trace query command exists at GRAPH-00, so
they are marked unsupported instead of being approximated with FTS or Obsidian links.

## Query inventory and baseline

| ID | Real question | Route | Expected entities / relation | Verifiable source | Latency ms | Approx. tokens | Baseline |
|---|---|---|---|---|---:|---:|---|
| F01 | Who owns `context-package.v1`? | FTS | ADR-0010, context contract | `.ai-code-control/memory/decisions/ADR-0010-context-package-v1.md` | 246 | 393 | complete |
| F02 | Which inputs trigger semantic invalidation? | FTS | ICM-04 task summary, invalidation reasons | `.ai-code-control/memory/tasks/2026-08-28-icm-04.md` | 160 | 418 | partial: locates prose, no typed reasons |
| F03 | How is a semantic source map enforced? | FTS | ICM-05 task summary | `.ai-code-control/memory/tasks/2026-08-28-icm-05.md` | 167 | 423 | partial: summary only |
| F04 | What is the current usage calibration? | FTS | ICM-06 calibration result | `.ai-code-control/memory/tasks/2026-08-28-icm-06.md` | 166 | 370 | complete |
| F05 | What role does Obsidian have? | FTS | CLI contract and code-map policy | `CLAUDE.md`, root `docs/OBSIDIAN-CODE-MAP.md` | 174 | 86 | partial: root policy is outside memory ingest scope |
| F06 | Is vector search refactor truth? | FTS | ADR-0004 | `.ai-code-control/memory/decisions/ADR-0004-vector-search-not-refactor-truth.md` | 171 | 321 | complete |
| F07 | How do planner IDs reach worker evidence? | FTS | ICM-01 and ICM-05 summaries | planner task summary, control ICM-05 summary | 179 | 410 | partial: evidence spans two memory roots |
| F08 | What does glass-box enforcement block? | FTS | ICM-05 task summary | `.ai-code-control/memory/tasks/2026-08-28-icm-05.md` | 164 | 240 | complete |
| F09 | Which memory store is canonical? | FTS | ADR-0006 | `.ai-code-control/memory/decisions/ADR-0006-markdown-is-canonical-memory.md` | 156 | 406 | complete |
| F10 | What live release work is pending? | FTS | ICM-06 summary | `.ai-code-control/memory/tasks/2026-08-28-icm-06.md` | 176 | 395 | complete, with OR-query noise |
| C01 | Where is symbol lookup implemented? | code graph | `SymbolQueryService` and members | `Services/SymbolQueryService.cs` | 203 | 828 | complete, 10 matches |
| C02 | Where is context compilation implemented? | code graph | `ContextPackageCompiler` and members | `Services/ContextPackageCompiler.cs` | 185 | 3,204 | partial: 37 substring matches |
| C03 | Where is Obsidian export implemented? | code graph | `ObsidianExportService` and members | `Services/ObsidianExportService.cs` | 165 | 3,065 | partial: 37 substring matches |
| C04 | Where is the SQLite schema initialized? | code graph | `DatabaseInitializer` and members | `Services/DatabaseInitializer.cs` | 163 | 347 | complete, 4 matches |
| C05 | Where is memory FTS queried? | code graph | `MemorySearchService` and members | `Memory/Services/MemorySearchService.cs` | 171 | 340 | complete, 4 matches |
| C06 | What calls `SymbolQueryService` transitively? | code graph | incoming `constructs` and `calls` edges | 3 files reported by `impact-analysis` | 178 | 687 | complete, 8 affected symbols |
| C07 | What is the blast radius of context compilation? | code graph | incoming code edges | `ContextPackageCompiler` impact result | 181 | 290 | complete, 3 affected symbols |
| C08 | What is the blast radius of Obsidian export? | code graph | incoming code edges | `ObsidianExportService` impact result | 178 | 373 | complete, 4 affected symbols |
| C09 | What depends on database initialization? | code graph | incoming code edges | `DatabaseInitializer` impact result | 188 | 903 | complete, 10 affected symbols |
| C10 | What depends on memory search? | code graph | incoming code edges | `MemorySearchService` impact result | 173 | 603 | complete, 7 affected symbols |
| T01 | Why is `context-package.v1` authoritative? | trace graph | ADR `references` contract; contract `supersedes` revision | ADR-0010 and contract schema | n/a | 0 | unsupported |
| T02 | Which criteria verify semantic invalidation? | trace graph | criterion `verified_by` gate/evidence | ICM source map and evidence artifacts | n/a | 0 | unsupported |
| T03 | Which evidence supports the ICM-06 verdict? | trace graph | task/run `verified_by` gate/evidence | ICM-06 summary and pilot outputs | n/a | 0 | unsupported |
| T04 | Which ADR is current and what did it supersede? | trace graph | ADR `supersedes` ADR | versioned ADR frontmatter/content | n/a | 0 | unsupported |
| T05 | Why was a source selected for a task? | trace graph | source `selected_for` task via context package | `context-package.v1` and `source-map.v1` | n/a | 0 | unsupported |

## Aggregate baseline

| Metric | FTS | Code graph | Trace graph | Overall |
|---|---:|---:|---:|---:|
| Cases | 10 | 10 | 5 | 25 |
| Executable answers | 10 | 10 | 0 | 20 (80%) |
| Responses with verifiable source locations | 10 | 10 | 0 | 20 (80%) |
| Direct complete answers | 6 | 8 | 0 | 14 (56%) |
| Mean latency for supported cases | 176 ms | 179 ms | n/a | 177 ms |
| Mean approximate output tokens | 346 | 1,064 | n/a | 705 |

The baseline indicates a query-shape problem, not a database-scale problem. Local latency
is already low. The visible costs are missing multi-hop trace answers and oversized
substring symbol results. A second database technology, embeddings, or GraphRAG would
not directly repair either issue.

## Query routing policy

| Query shape | Authoritative route | Fallback | Enforcement use |
|---|---|---|---|
| Plain text, prior discussion, topic discovery | memory FTS | bounded source reads | context only |
| Exact symbol, callers, imports, blast radius | code graph | compiler/tests if ambiguous | yes, with structural provenance |
| Why, current decision, criterion, task, run, gate, evidence | trace graph | fail as unsupported until GRAPH-03 | yes for T0/T1 only |
| Human architecture exploration | Obsidian projection | Markdown/Canvas regeneration | never |
| Semantic suggestion | optional inferred route | none | never; advisory T2 only |

Routing must be explicit in the response. A router must not silently answer a trace query
with an FTS excerpt because relevance is not a verified relationship.

## Edge vocabulary use-case gate

No trace edge type proceeds to GRAPH-01 without at least two concrete uses:

| Edge type | Use case 1 | Use case 2 |
|---|---|---|
| `supersedes` | current ADR replaces an older ADR | current contract revision replaces a prior revision |
| `depends_on` | task depends on another task | rule or decision declares a prerequisite |
| `implements` | symbol/file implements a contract | task implements an acceptance criterion |
| `verified_by` | criterion verified by a passing gate | contract/rule verified by evidence from a run |
| `derived_from` | context package derived from selected sources | evidence/source map derived from run artifacts |
| `changes` | commit changes a file | run produces a commit or changed symbol set |
| `references` | ADR references a contract | evidence references a command artifact |
| `selected_for` | source selected for a task | context package selected for a run/task input |

Automatic `caused` is rejected. Causality may be added only by a later ADR with declared
human approval and direct evidence.

## Threat model

| Threat | Failure mode | Required control |
|---|---|---|
| Path leakage | absolute paths or private repository layout leave the trust boundary | repository-relative canonical refs; redact output; explicit external-vault policy |
| Stale graph | a cached edge is treated as current after source or commit changes | source hash/commit, ingest run, `valid_from`/`valid_to`, fail-closed current queries |
| Inferred-edge escalation | an LLM suggestion influences authorization or verdict | T2 stored separately, excluded from authoritative queries and enforcement |
| Source poisoning | untrusted Markdown declares privileges or false relations | trust classification, strict edge vocabulary, schema validation, monotonic restrictions |
| Identity collision | titles or ambiguous symbol names merge unrelated entities | namespace plus canonical ref IDs; ambiguity is a diagnostic, never first-match selection |
| Source-of-truth inversion | SQLite or Obsidian becomes canonical | full rebuild test; versioned source links; no write-back from projections |
| Cross-repository disclosure | a query joins nodes from repositories the caller cannot access | repository/scope binding on nodes, queries, exports, and MCP responses |
| Evidence replay | old passing evidence verifies changed code | bind evidence to run, manifest/source-map digest, commit, and validity interval |

## Decision from the audit

Proceed with a separate temporal trace schema in the existing SQLite cache and a small
query router. Keep the current code `edges` table intact for compatibility; do not put
heterogeneous trace nodes into it. Extend Obsidian only after authoritative trace queries
and drift checks exist. Do not add Neo4j, embeddings, or GraphRAG during the core plan.
