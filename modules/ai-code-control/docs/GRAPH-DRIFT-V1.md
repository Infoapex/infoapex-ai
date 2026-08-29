# Graph drift v1 contract

Status: internal enforcement contract introduced by GRAPH-05

## Command

```text
ai-code-control graph-drift --scope . --format json
  [--sources contracts/trace-sources.json]
  [--expected-graph contracts/expected-trace-graph.json]
  [--projection-manifest docs/code-map/generated/trace-manifest.json]
  [--minimum-coverage 100]
  [--expected-commit <commit>]
  [--skip-freshness]
  [--fail-on-review]
```

The CLI compares trace ingest commits with repository HEAD unless
`--expected-commit` overrides it or `--skip-freshness` explicitly disables the
comparison. It exits with code 2 for `FAIL`; `--fail-on-review` also maps
`REVIEW_REQUIRED` to exit code 2. MCP exposes the same operation as `graph_drift`.

## Deterministic inputs

The checker never scans arbitrary prose and never calls an LLM. Optional control files
must be declared explicitly and remain inside `--scope`:

- `trace-sources.v1`: required or optional canonical node identities and optional
  expected source hashes;
- `expected-trace-graph.v1`: exact or subset authoritative node/edge fixture;
- `trace-projection-manifest.v1`: graph digest, repository commit, and complete
  source-namespace/hash set produced by GRAPH-04.

Files are limited to 2 MiB. Absolute host paths, file URIs, scope traversal, unknown
vocabulary, duplicate identities, invalid trust tiers, and malformed hashes fail closed.
Errors returned through CLI/MCP use repository-relative identities and never echo an
outside host path.

Version 1 accepts repository-root scope (`--scope .`) only. A narrower scope is rejected
instead of silently evaluating the whole database under a misleading subdirectory label.

## Checks

The report always includes all applicable checks:

- non-empty current graph;
- declared canonical source presence, authority, and source hash;
- node/edge vocabulary, hashes, and endpoint integrity;
- latest ingest-run provenance and repository commit freshness;
- ambiguous current identities, T2 presence, and T0/T1 edges touching proposed/advisory
  endpoints;
- branching or cyclic authoritative `supersedes` relationships;
- criterion coverage through task `implements` criterion, criterion `verified_by`
  gate, and gate `verified_by` evidence;
- differences from an expected graph fixture;
- projection digest, commit, and source-hash drift.

Current rows are read even if SQLite checks were bypassed externally, so dangling or
unknown corrupt data is reported rather than trusted. T2 and proposed/advisory endpoints
are excluded from authoritative coverage and fixture comparison.

## Classification

- `PASS`: no errors or warnings and every configured threshold/input passes.
- `REVIEW_REQUIRED`: only advisory conditions exist, including T2, ambiguous
  identities, optional sources, incomplete non-threshold evidence, or an empty graph.
- `FAIL`: any authoritative integrity, required source, freshness, supersession,
  coverage, expected-fixture, or configured projection error.

An absent expected fixture or projection manifest is `not_applicable`, not a fabricated
pass. A missing source manifest is stricter: it produces `REVIEW_REQUIRED`, because
canonical source presence cannot otherwise be enforced. Projection drift remains
`not_applicable` until GRAPH-04 declares a manifest. An empty graph is always
`REVIEW_REQUIRED`, so a consumer cannot claim enforcement success before ingestion.

## Contracts

- `contracts/trace-sources.v1.schema.json`
- `contracts/expected-trace-graph.v1.schema.json`
- `contracts/trace-projection-manifest.v1.schema.json`

Examples are versioned under `contracts/examples/`.
