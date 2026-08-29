# GRAPH-03 - bounded trace traversal and query routing

Status: implemented and validated locally on 2026-08-28.

## Outcome

- Added a deterministic `TraceGraphQueryService` over current temporal graph state.
- Added explicit `trace`, `why`, `affected`, `current`, and `evidence-for` CLI
  commands plus matching MCP tools.
- Every result declares `route=trace_graph` and `fallbackUsed=false`; text discovery
  remains on memory FTS and structural symbol/blast-radius queries remain on the code graph.
- Entity resolution uses exact node ID, canonical ref, or title before an unambiguous
  simple name. Wrong root types, ambiguous identities, missing entities, stale source
  commits, and truncated traversals have distinct statuses.
- Traversals enforce caller-provided depth, node, and edge budgets within hard caps of
  10, 200, and 500, with cycle detection and explicit truncation reasons.
- T2 is excluded by default. Opt-in T2 results are advisory and non-authoritative.
- Node and edge source namespace/hash/commit, origin, trust tier, authority, confidence,
  validity, and evidence are returned. Raw cached properties JSON is not exposed.
- Added human and agent documentation plus a repeatable 25-question evaluation.

## Validation

- AI Code Control: 92/92 tests PASS; 13 tests cover GRAPH-03 query behavior.
- MCP TypeScript build: PASS.
- Built CLI smoke query: valid camel-case JSON and no fallback on a trace miss.
- Preregistered hybrid inventory: 25/25 route/entity/evidence accuracy.
- Existing FTS/code cases: 20/20 expected source/structural results, end-to-end p95 173 ms.
- New trace cases: 5/5, with evidence-complete T0/T1 paths.
- Warm local trace query p95: 2.572 ms over 100 samples, below the 250 ms threshold.
- Hard budget, ambiguity, staleness, unsupported route, not-found, cycle, and advisory
  behavior: PASS.
- Generic bundle boundary: PASS.
- `verify-changed-files`: PASS with no unexpected, forbidden, or conflicting files.
- `run-validation`: PASS for .NET build/test and MCP install/build.

## Measurement

The preregistered range was 3.2M / 4.4M / 5.5M reported tokens. Actual usage was
5,841,348 tokens, 32.76% above the median and 6.21% above the high estimate, so the
stage is YELLOW with a range miss. Usage rose from 23% to 46% on profile
`codex:gpt-5.6-sol:high`, approximately 253,972 tokens per point and 2.98% above
prospective calibration `ICM-CLEAN-V1-2026-08-28`. No parallel Codex sessions were
reported.

Across GRAPH-00 through GRAPH-03, prediction drift is YELLOW: MAPE 19.7%, 75% range
hits, and median usage mapping 259,503 tokens per percentage point.

## Open issues

- The module's current trace cache is empty until a consumer calls the deterministic
  GRAPH-02 ingestion API with its explicitly declared sources. Query commands fail
  transparently with `not_found`; they do not fabricate relations from FTS.
- Direct answer completeness is 19/25 (76%) because GRAPH-03 does not change the known
  verbosity of FTS and broad substring symbol lookup. Route/entity/evidence accuracy is
  25/25.
- Graph drift enforcement is intentionally deferred to GRAPH-05, the next approved stage.

## Next step

GRAPH-05 adds graph drift detection and enforcement gates before investing in the full
Obsidian trace projection.
