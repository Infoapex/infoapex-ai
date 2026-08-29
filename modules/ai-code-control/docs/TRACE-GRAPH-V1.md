# Trace graph v1 contract

Status: internal repository contract introduced by GRAPH-01

## Boundary

The trace graph is a rebuildable SQLite cache over canonical ADRs, contracts, plans,
source maps, and runtime evidence. It is separate from:

- execution DAG state in AI Code Worker;
- structural code symbols and the existing `edges` table;
- memory FTS;
- the Obsidian projection.

GRAPH-01 provides storage and repository semantics only. Source ingestion, public query
commands, MCP routing, drift gates, and Obsidian trace export are later stages.

GRAPH-02 adds deterministic source ingestion. GRAPH-03 adds bounded public queries and
MCP routing. GRAPH-05 adds deterministic authoritative drift enforcement. GRAPH-04 adds
the disposable Obsidian projection. GRAPH-07 exposes ingest through strict CLI/MCP
`trace-ingest`/`trace_ingest` surfaces that accept only an explicit repository-local
`trace-ingest-manifest.v1`; no discovery or model inference enters the T0/T1 path.

## Tables

Schema version 3 adds:

- `trace_nodes`: temporal versions of stable heterogeneous identities;
- `trace_edges`: temporal versions of typed, evidenced relationships;
- `trace_ingest_runs`: rebuildable audit data for incremental, invalidation, and rebuild
  operations.

`node_id` remains stable across title or property changes and is SHA-256 over the node
namespace plus canonical reference. `edge_id` is SHA-256 over source namespace,
endpoints, relationship type, origin, and evidence reference. Database row IDs are local
implementation details and never leave the cache.

Only one current version (`valid_to IS NULL`) may exist for a node or edge identity.
Changed content closes the old interval and inserts a new version. Current reads exclude
closed intervals; history reads preserve them.

## Vocabulary and trust

Node types:

`adr`, `rule`, `contract`, `criterion`, `task`, `run`, `gate`, `evidence`, `commit`,
`file`, `symbol`, `context-package`.

Edge types:

`supersedes`, `depends_on`, `implements`, `verified_by`, `derived_from`, `changes`,
`references`, `selected_for`.

Trust is enforced in both the repository and SQLite constraints:

| Tier | Origins | Confidence | Authoritative use |
|---|---|---|---|
| T0 | `ast`, `git`, `json-contract`, `runtime-evidence` | `deterministic` | allowed |
| T1 | `adr`, `frontmatter`, `manifest` | `declared` | policy-controlled |
| T2 | `model` | `inferred` | advisory only |

Every edge requires an evidence reference. Automatic `caused` is not in the schema and
is rejected even if a caller writes directly to SQLite.

## Repository invariants

`TraceGraphRepository` enforces:

- canonical JSON objects for properties, independent of property order;
- lowercase SHA-256 source hashes;
- repository-relative file canonical refs and no absolute evidence paths;
- no duplicate identities within a snapshot;
- no node identity ownership collision between source namespaces;
- no missing edge endpoints;
- monotonically increasing effective time for changes;
- no source invalidation that would orphan a current edge owned by another source;
- compare-and-invalidate through an expected source commit;
- transactional full rebuild and deterministic current-state digest.

`ApplySnapshot` is an idempotent temporal upsert. `InvalidateSource` requires the current
source commit and fails closed on a stale precondition. `Rebuild` accepts the complete
set of source snapshots in any order, clears only trace cache tables in one transaction,
and recreates a deterministic current graph.

## Deterministic ingestion

`TraceGraphIngestService` accepts an explicit list of declared documents. It does not
crawl arbitrary files and does not call an LLM. Supported kinds are:

- `adr`: accepted/proposed authority and explicit `Supersedes:` declarations;
- `contract`: JSON Schema identity plus explicit `criterionId` values;
- `plan`: task, criterion, gate, dependency, and required-input declarations;
- `source-map`: ICM runtime nodes and edges, with relation direction normalized to the
  trace vocabulary;
- `context-package`: package/source/task selection provenance;
- `relations`: strict `trace-relations.v1` JSON sidecars for additional T1 edges.

The code index contributes file and fully-qualified symbol nodes. A simple symbol name is
linked only when it resolves to exactly one code symbol. Zero or multiple candidates emit
diagnostics and the affected edge is skipped; the first candidate is never selected.

Multiple artifacts may describe the same stable identity. The ingestor merges them by a
deterministic precedence that favors canonical authority, structural/contract sources,
and informative declared titles. Every merge emits a provenance diagnostic. Proposed
decisions remain `authority=proposed` and cannot be mistaken for accepted decisions.

JSON contracts and plans use canonical JSON hashes. Source maps and context packages use
their semantic digests when present, so timestamps and property order do not invalidate
unchanged entities. Applying a new repository commit versions only nodes and edges whose
semantic source hash or payload changed.

Declared relation sidecars validate against
`contracts/trace-relations.v1.schema.json`. The schema excludes `caused`, requires direct
evidence, and permits only the accepted node and edge vocabularies.

## Source-of-truth rule

Deleting all trace tables and rebuilding them from versioned sources must recover the
same current graph. The trace database and future Obsidian export must never authorize a
change independently of their canonical source and evidence references.

## Public query contract

GRAPH-03 exposes five explicit trace routes:

- `trace <entity>`: bounded bidirectional exploration for any trace entity;
- `why <symbol-or-file>`: declared explanation links for an exact code identity;
- `affected <contract-or-adr>`: declared downstream and neighboring trace links;
- `current <adr-or-rule>`: incoming `supersedes` lineage to the terminal entity;
- `evidence-for <criterion-or-task>`: outgoing `implements` and `verified_by`
  paths to gates and evidence.

Every response reports `route=trace_graph`, `fallbackUsed=false`, hard depth/node/edge
limits, source freshness, full node and edge provenance, evidence paths, and traversal
metrics. Status is explicit: `ok`, `not_found`, `ambiguous`, `unsupported`,
`stale`, or `partial`. A trace miss never falls back to FTS or structural symbol
search. Callers must use `memory-search`, `find-symbol`, or `impact-analysis` for
those query shapes.

Raw `properties_json` is intentionally not returned through CLI/MCP. The public result
contains typed identity and provenance fields only, which bounds context and avoids
forwarding arbitrary cached metadata across the tool boundary.

`graph-drift` is the enforcement surface over the same current state. It checks
structural integrity, declared sources, freshness, supersession, criterion evidence
coverage, expected fixtures, and an optional GRAPH-04 projection manifest. See
`docs/GRAPH-DRIFT-V1.md`.

T2 nodes and edges are excluded by default. `--include-advisory` opts in, and any
result containing T2 is marked `advisory=true` and `authoritative=false`. Current
queries treat a branching supersession lineage as ambiguous. Evidence queries do not
walk unrelated references. Maximum accepted limits are depth 10, 200 nodes, and 500
edges; smaller caller-provided budgets are always honored.
