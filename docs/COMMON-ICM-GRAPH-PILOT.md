# Common ICM + Graph pilot

Status: internal deterministic pilot passed on 2026-08-29. A bounded usage-consuming
live pilot remains required before a production release claim.

## Scope

Run with:

```text
npm run pilot:icm-graph:internal
```

The gate creates an isolated generic consumer repository and removes it after the run.
It does not call a live model, modify the main worktree, or use Obsidian as an agent
query engine.

The common pilot combines:

- the 20-task ICM planner/worker/source-map/invalidation matrix;
- a strict declared `trace-ingest` manifest;
- 10 traceable pilot tasks with criterion → gate → evidence chains;
- 25 hybrid route fixtures: five temporal, five evidence, five contract-to-code/evidence,
  five structural blast-radius, and five memory FTS queries;
- five supersession chains;
- expected-graph, mandatory-source, coverage, projection, and drift checks.

## Final internal result

- ICM tasks: 20/20 DONE, five in each preregistered category.
- ICM trace coverage and direct evidence: 100%.
- ICM first-pass gate rate: 100%; semantic invalidation: 5/5.
- Graph queries: 25/25 on their declared route.
- Traceable graph tasks: 10; temporal chains: 5.
- Contract → code → evidence: 5/5.
- Structural code blast radius: 5/5.
- FTS-only queries: 5/5.
- Trace ingest: 17/17 documents, 70 nodes and 55 edges, zero error/warning diagnostics.
- Graph drift: PASS; mandatory evidence coverage: 100%.
- Fresh Obsidian projection: PASS with no digest/source-hash drift.
- Decision: `INTERNAL_PASS_LIVE_REQUIRED`.

Development measurement for GRAPH-07 was `10,080,331` reported tokens and 33 comparable
usage percentage points, versus the preregistered `2.2M / 3.0M / 4.0M` range. The
prediction is RED: `+236.01%` versus the median and `+152.01%` above the high estimate.
Across GRAPH-00–07, MAPE is `78.2%`, range hit rate `42.9%`, and the observed median is
`265,197 tokens/pp`. These figures measure implementation sessions, not provider-live
task economics; they are a reason to require the sequential live baseline before GRAPH-06.

The first execution correctly returned BLOCKED at 15/25. Five blast-radius assertions
treated the numeric `affectedSymbols` field as an array, and an artificial dependency
chain forced five bounded `affected` queries to return partial. The harness was corrected
to match the public response contract and isolate the five intended contract scenarios;
the engine, query budgets, expected graph, and release thresholds were not relaxed.

## Operational gap closed by the pilot

GRAPH-02 had a deterministic ingestion service but no supported CLI/MCP entry point, so
a real consumer could not populate the graph without private code. The pilot adds:

- `trace-ingest --manifest <path>` and MCP `trace_ingest`;
- `trace-ingest-manifest.v1` JSON Schema;
- repository-bound path validation, strict unknown-property rejection, duplicate
  identity checks, dry-run, commit override, and optional code-index exclusion;
- idempotent full trace-cache replacement from the declared snapshot.

## Remaining release work

The internal fixture proves contracts and deterministic behavior, not provider economics.
Before production release, run the existing usage-consuming mode on 10 bounded real tasks
and record accuracy, retries, uncached context, total tokens, and explanation time. This
requires explicit authorization because it consumes provider quota.

GRAPH-06 parallel reviewers stays disabled. It becomes eligible only after the live
sequential baseline exists and must meet all preregistered A/B thresholds.
