# Task - 2026-08-29 - GRAPH-04 typed Obsidian trace projection

## Goal

Turn the existing Obsidian code map into a disposable typed projection of both the code
and trace graphs, with deterministic freshness enforcement and no planner/worker runtime
dependency.

## Context used

- ADR-0011 hybrid code/trace graph and the GRAPH-04/GRAPH-05 implementation plan.
- Temporal trace state and digest from `TraceGraphRepository`.
- Existing `ObsidianExportService`, CLI/MCP surface, projection manifest schema, and
  `TraceGraphDriftService`.

## Changes made

- Added trace notes for ADR, rule, contract, criterion, task, gate, and evidence with
  typed YAML provenance and explicit relation labels.
- Added default current T0/T1 filtering plus opt-in T2 and superseded views.
- Linked trace endpoints to generated code-file and code-symbol notes where resolvable.
- Added a trace index and `trace-map.canvas`, separate from the existing code canvas.
- Added staging + directory swap so regeneration removes stale notes and never publishes
  a partially generated vault.
- Added `.trace-projection-manifest.json` with full graph digest, repository commit, and
  exact authoritative source hashes; GRAPH-05 validates it without special integration.
- Extended CLI and MCP arguments with `includeAdvisory` and `includeSuperseded`.
- Made CLI database initialization idempotently apply migrations to existing caches;
  this fixed the smoke-test failure `no such table: trace_nodes`.
- Updated Obsidian and module documentation.

## Validation

- `dotnet test .../AiCodeControl.sln --nologo`: PASS, 109/109.
- MCP `npm run build`: PASS.
- `run-validation --repo modules/ai-code-control`: PASS for dotnet build/test and MCP
  npm install/build.
- Generated `.trace-projection-manifest.json`: strict AJV 2020-12 PASS.
- `verify-changed-files`: PASS; generic boundary: PASS; `git diff --check`: no errors.
- Four GRAPH-04 tests prove typed links/filters, stale-note removal, and manifest drift.
- Usage: 6,137,379 actual tokens versus 2.5M / 3.4M / 4.3M predicted, RED
  (+80.51% versus median; 42.73% above high). Percentage-point mapping is not comparable
  because the rate-limit window reset between the 86% start and 9% end checkpoints.
- Aggregate GRAPH-00..05: RED, MAPE 51.9%, range-hit rate 50%, median 265,035
  tokens/percentage point across the five usage-comparable stages.

## Open issues

- The repository trace cache is currently empty until declared sources are ingested;
  the real vault therefore remains review-only and cannot claim release readiness.
- The typed projection is intentionally batch-generated; no Obsidian plugin or live
  streaming dependency is introduced.
- No commit was created.

## Next recommended task

Run GRAPH-07: ingest a declared pilot graph, execute at least 25 query fixtures and 10
real tasks, measure accuracy/latency/usage drift, and make the release decision. GRAPH-06
parallel reviewers remains optional.
