# GRAPH-05 - graph drift and authoritative enforcement

Status: core enforcement implemented and validated locally on 2026-08-29.

## Outcome

- Added `TraceGraphDriftService`, CLI `graph-drift`, and MCP `graph_drift`.
- Reports classify current graph state as `PASS`, `REVIEW_REQUIRED`, or `FAIL`.
- A release PASS requires a declared source manifest; missing declaration is review,
  while missing required sources, wrong authority, or source-hash drift fail.
- Integrity checks detect unknown vocabulary, dangling edges, invalid hashes, nodes or
  edges without ingest-run provenance, and stale latest ingest commits.
- Trust checks exclude T2 and proposed/advisory endpoints from authoritative enforcement.
- Temporal checks fail branching and cyclic authoritative supersession lineages.
- Coverage checks require task -> criterion -> gate -> evidence and enforce the configured
  minimum percentage.
- Expected fixtures support exact or subset comparison with deterministic node/edge diffs.
- Projection manifests compare graph digest, commit, and the complete source-hash set.
  Projection drift is `not_applicable` until GRAPH-04 declares the manifest.
- Declared control files are bounded to 2 MiB, repository-root scoped, path-safe, and do
  not expose outside absolute host paths in output.

## Contracts

- `trace-sources.v1.schema.json`
- `expected-trace-graph.v1.schema.json`
- `trace-projection-manifest.v1.schema.json`

All three examples pass strict AJV 2020-12 validation.

## Validation

- AI Code Control: 105/105 tests PASS; 13 tests are specific to GRAPH-05.
- Positive release fixture with complete evidence and a declared source manifest: PASS.
- Empty graph and populated graph without source manifest: REVIEW_REQUIRED.
- Corruption, staleness, required-source drift, coverage gaps, supersession conflict,
  expected-graph drift, and projection drift fixtures: FAIL.
- `--fail-on-review` maps the module's current empty graph to exit code 2.
- MCP TypeScript build: PASS.
- Generic bundle boundary: PASS.
- `verify-changed-files`: PASS with no unexpected, forbidden, or conflicting files.
- `run-validation`: PASS for .NET build/test and MCP install/build.

## Measurement

The preregistered range was 2.5M / 3.5M / 4.5M reported tokens. Actual usage was
8,822,036 tokens, 152.06% above the median and 96.05% above the high estimate, so the
stage is RED. Usage rose from 50% to 80% on `codex:gpt-5.6-sol:high`, approximately
294,068 tokens per point and 19.24% above prospective calibration
`ICM-CLEAN-V1-2026-08-28`. No parallel Codex sessions were reported.

Across GRAPH-00 through GRAPH-05, prediction drift is RED: MAPE 46.2%, 60% range hits,
and median usage mapping 265,035 tokens per percentage point.

## Open issues

- The module's trace cache is intentionally still empty because no consumer source set
  has been ingested. Its real report is REVIEW_REQUIRED, never a release PASS.
- GRAPH-04 must emit `trace-projection-manifest.v1`; the already implemented checker
  will then activate projection drift without changing the enforcement contract.
- GRAPH-07 still requires a consumer project and real task/evidence histories.

## Next step

GRAPH-04 adds the typed Obsidian projection and emits the projection manifest consumed
by this gate.
