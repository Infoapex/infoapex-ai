# ADR 0010: Semantic inputs extend task snapshots and drive incremental invalidation

- Status: Accepted
- Date: 2026-08-28

## Context

Dependency commits alone do not describe every input that can change an agent's
result. Compiled context, executable contracts, gate definitions, worker policy, and
selected toolchain configuration can drift while the dependency DAG remains the same.
Re-running every task on any repository change would remove most of the value of the
graph and would make unrelated files hidden inputs.

## Decision

`task-input-snapshot` v1.1 adds:

- `contextDigest` and `contextCompilerVersion`;
- ordered canonical `contractHashes`;
- `qualityGateConfigHash` for only the task/global gates the task executes;
- `policyHash` for scope, concurrency, risk, routing, sync-root, and context mode;
- `toolchainConfigHash` for selected, declared toolchain sources.

The context package is the source of truth for selected source hashes when available.
Without a package, exact declared required-input files may contribute contract and
toolchain hashes. Arbitrary repository discovery, glob expansion, timestamps, absolute
checkout paths, and LLM relevance guesses are forbidden.

The incremental planner compares semantic fields and dependency commits. It returns:

1. directly invalidated tasks with machine-readable reasons;
2. tasks reusable as-is;
3. descendants that remain reusable unless the directly re-executed dependency emits
   a different verified commit.

The existing descendant invalidator remains responsible for the third step after a
commit actually changes. A terminal frozen run is never reopened in place; applying an
incremental plan to terminal work requires the existing graph-revision mechanism and a
new authorization.

## Consequences

- A selected source change invalidates its consumer; an unselected source change does
  not.
- Canonical JSON, sorted set-like fields, and sorted source hashes avoid ordering drift.
- Compiler upgrades are visible as their own invalidation reason rather than an opaque
  context digest mismatch.
- Changing an unrelated quality-gate definition does not invalidate a task.
- Snapshot metadata now proves both filesystem dependency identity and semantic input
  identity before enforcement pilots.
