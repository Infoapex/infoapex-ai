# GRAPH-07 - common ICM + Graph pilot and release decision

Status: deterministic internal pilot passed on 2026-08-29; provider-live pilot pending.

## Outcome

- Added strict `trace-ingest-manifest.v1` and repository-bound loader.
- Added CLI `trace-ingest` and MCP `trace_ingest`, including dry-run, commit override,
  optional code-index exclusion, strict properties, duplicate detection, and traversal
  refusal. This closes the gap where GRAPH-02 ingestion had no supported consumer entry.
- Added `npm run pilot:icm-graph:internal`, which creates and removes an isolated generic
  consumer repository and composes ICM execution with graph ingestion/query/drift/export.
- Updated release documentation and root TODO; GRAPH-06 stays disabled.

## Pilot result

- ICM: 20/20 DONE, 100% trace/direct evidence/first-pass gate, invalidation 5/5.
- Graph: 25/25 hybrid queries, 10 traceable tasks, five supersession chains, five
  contract-code-evidence queries, five code blast-radius queries, and five FTS queries.
- Ingest: 17/17 documents, 70 nodes, 55 edges, zero error/warning diagnostics.
- Graph drift PASS, mandatory evidence coverage 100%, projection PASS.
- First run BLOCKED at 15/25 because the harness treated a numeric response as an array
  and coupled isolated affected scenarios through artificial task dependencies. The
  public contract assertions and fixture isolation were corrected; thresholds and query
  budgets were not relaxed.
- Decision: `INTERNAL_PASS_LIVE_REQUIRED`.

## Usage measurement

- GRAPH-07 actual: 10,080,331 reported tokens and 33 comparable usage percentage points.
- Prediction: 2.2M / 3.0M / 4.0M; RED, +236.01% versus median and +152.01% above high.
- Observed rate: approximately 305,465 tokens/pp, +23.86% versus the ICM calibration.
- GRAPH-00–07 aggregate: RED, MAPE 78.2%, range hit 42.9%, median 265,197 tokens/pp.
- Consequence: do not use the current estimate to authorize GRAPH-06; obtain the bounded
  sequential provider-live baseline first.

## Validation

- AI Code Control: 113/113 PASS; new manifest tests 4/4.
- Root build/tests: PASS; MCP build: PASS.
- Internal review and documentation gates: PASS.
- Strict AJV validation of the new schema/example: PASS.
- Module validation runner: dotnet build/test and MCP install/build PASS.
- Generic bundle boundary and diff check: PASS.

## Remaining work

- Run the usage-consuming common pilot on 10 bounded real sequential tasks with explicit
  provider-quota authorization. Record accuracy, retries, uncached context, total tokens,
  and explanation time before a production release claim.
- GRAPH-06 is optional and must not start before that sequential baseline. No GraphRAG
  expansion is justified by the current 25/25 deterministic result.
- No commit was created.
