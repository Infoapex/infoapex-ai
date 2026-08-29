# ADR 0011: Semantic source maps are generated evidence, not inferred causality

- Status: Accepted
- Date: 2026-08-28

## Context

Planner trace IDs, context-package provenance, worker commits, and gate evidence are
individually auditable, but investigating a verdict still requires manually joining
several artifacts. A generic knowledge graph could make this look connected while
silently losing IDs or promoting model inference to execution authority.

## Decision

Worker-contract v1.1 runs generate `source-map.v1.json` before `run.done`. The map uses
stable hashed node/edge IDs and only six relations:

- `selected_for`, `requires`, `implemented_by`, `changed_by`, `verified_by`, and
  `derived_from`.

Nodes cover declared criteria, tasks and gates plus observed context sources, files,
commits, evidence and context packages. Every edge records its confidence as declared,
observed, or deterministically derived and names the artifact that proves it.

The worker does not generate `caused`. LLM-inferred relations require a future advisory
layer and cannot participate in enforcement.

Before a traceable run can reach DONE, every criterion ID and gate link must round-trip
through task evidence and at least one linked command must have exit code zero. A
missing ID, missing/non-passing evidence, or duplicate stable ID blocks completion.
Sources marked `proposed` may be selected as advisory context but cannot be endpoints
of `verified_by` edges and cannot authorize a PASS verdict.

The source-map digest excludes creation time and is recomputed before persistence.
Markdown authority is carried from the compiled context package; the source map itself
is generated evidence and never outranks contracts, manifests, or accepted decisions.

## Consequences

- A verdict can be followed from rule/contract and criterion to task, changed files,
  commit, gate, and evidence without consulting SQLite or Obsidian.
- Boundary ID loss becomes a contract failure rather than a documentation defect.
- Legacy v1.0 manifests remain compatible and do not activate source-map enforcement.
- Obsidian can visualize the artifact later, but it is not the machine contract.
