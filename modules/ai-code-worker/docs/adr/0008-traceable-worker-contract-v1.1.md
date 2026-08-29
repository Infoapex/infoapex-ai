# AICW-ADR-008: Traceable worker contract v1.1

- Status: accepted
- Date: 2026-08-28
- Owner: planner/worker interoperability
- Related plan: `docs/plans/ICM-SELECTIVE-IMPLEMENTATION-PLAN.md`, ICM-01

## Context

The planner owns stable `criterionId`, `gateId`, and `evidenceContract` values, but
worker manifest v1.0 retained only criterion text and verification command strings.
Independent review already used criterion IDs, so inventing IDs after compilation
made the apparent evidence chain ambiguous.

## Decision

Worker manifest v1.1 adds per-task `traceability` while retaining the v1.0
`acceptanceCriteria` and `verify` arrays used by the current execution runtime.
The compiler rejects v1.1 when either representation differs by value or order.

Each traceable gate declares a non-empty `criterionIds` list. Criterion and gate IDs
are globally unique within a plan; dangling references and criteria not covered by a
gate are blockers. No name-based or positional criterion relationship is inferred.

Planner `compile` emits `workerContractVersion: "1.1"`. Worker plans without this
field compile as manifest v1.0, preserving the legacy compatibility path.

Task evidence produced from a traceable task uses evidence schema v1.1 and records:

- the task ID and criterion IDs;
- each gate ID and its criterion links;
- the declared evidence contract;
- the executed evidence command ID, or `null` when execution never produced one.

Aggregate run evidence remains v1.0 because it does not represent one task's semantic
trace. Independent review reads the stable criterion IDs from manifest traceability.

## Consequences

- Planner-to-worker projection is lossless for criterion, gate, and evidence-contract
  identifiers.
- Existing v1.0 accepted plans and manifest fixtures remain valid.
- The duplicated executable strings are temporary compatibility fields, protected by
  deterministic drift validation rather than human convention.
- Typed `requiredInputs.kind` remains a separately reported projection loss and is not
  silently claimed as solved by this decision.

## Rejected alternatives

- Replacing the executable string arrays immediately: too broad for the first
  compatible contract increment and would force all runners to migrate atomically.
- Reconstructing IDs from array position or names: unstable and semantically invented.
- Keeping identifiers only in Markdown: not machine-enforceable and cannot support
  evidence joins.

## Acceptance tests

1. v1.0 manifests still validate and compile.
2. A v1.1 planner projection reaches the frozen worker manifest with all IDs intact.
3. Duplicate, dangling, uncovered, or drifted mappings are rejected deterministically.
4. Evidence v1.1 links `criterionId -> gateId -> commandId/evidenceContract`.
5. No provider call is required by contract or round-trip tests.
