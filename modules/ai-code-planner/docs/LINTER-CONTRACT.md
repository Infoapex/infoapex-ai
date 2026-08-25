# Linter Contract

This document specifies every deterministic check the ai-code-planner linter runs before a plan is handed off for execution. These checks require no LLM invocation. They must all pass before the compile step may produce a worker export. Each check is identified by a stable error code used verbatim in every failure message.

**Reference:** _FINAL.md decision 7 (and decision 7b for the projection rules) in the consumer project planning repository under `Plan/Architect/`.

---

## Checks

### 1. DAG_ACYCLIC — Task dependency graph is acyclic

**What it checks:** The directed graph formed by all `task.dependsOn` edges within the plan contains no cycle. Every task must be reachable from the plan's entry tasks through a strict topological ordering.

**Failure mode:**

```
CYCLIC_DEPENDENCY: task <id> participates in a dependency cycle: <id> → <id2> → … → <id>
```

The `<path>` component lists every node in the detected cycle in traversal order, closing with the starting node so the cycle is unambiguous.

---

### 2. DEPENDENCY_EXISTS — Every dependsOn id resolves to a task in this plan

**What it checks:** For every entry in `task.dependsOn`, a task with that id must exist elsewhere in the same plan document. Cross-plan references are not supported; all dependencies are local.

**Failure mode:**

```
UNKNOWN_DEPENDENCY: task <id> dependsOn '<dep-id>' which does not exist in this plan
```

---

### 3. REQUIRED_INPUTS_TYPED — Every requiredInputs entry carries a typed provenance

**What it checks:** Every element of `task.requiredInputs` must be an object with both `kind` (one of `"file"`, `"symbol"`, `"external"`) and `ref` (a non-empty string), as defined in `schemas/plan.schema.json`. Bare path strings are not permitted; the `kind` discriminant is required so the compile step knows how to resolve the pointer at execution time.

**Failure mode:**

```
UNTYPED_INPUT: task <id> requiredInputs[<n>] is missing 'kind' or 'ref'
```

---

### 4. SCOPE_NO_UNCONTROLLED_OVERLAP — Parallel tasks in the same wave share no allowedPaths entries

**What it checks:** Any two tasks scheduled in the same execution wave (i.e., tasks with no `dependsOn` edge between them that would force sequential ordering) must not list the same path in their respective `scope.allowedPaths` arrays. Overlapping write domains between concurrent tasks constitute an uncontrolled race condition.

**Failure mode:**

```
SCOPE_OVERLAP: tasks <id-a> and <id-b> run in the same wave and share allowedPaths entries: <path1>, <path2>, …
```

---

### 5. SCOPE_NO_SELF_INTERSECTION — allowedPaths and forbiddenPaths are disjoint per task

**What it checks:** For each task, the intersection of `scope.allowedPaths` and `scope.forbiddenPaths` must be empty. A path that appears in both sets is a self-contradictory scope and the task cannot be safely executed.

**Failure mode:**

```
SCOPE_SELF_INTERSECTION: task <id> lists '<path>' in both allowedPaths and forbiddenPaths
```

---

### 6. HIGH_RISK_REQUIRES_GATES — High-risk tasks must declare at least one gate

**What it checks:** Any task with `risk: "high"` must have a non-empty `gates` array. A high-risk task with no verification gates has no evidence contract and cannot be considered complete under any automated protocol. This check enforces decision 7's requirement that `verify` is non-empty for high-risk tasks.

**Failure mode:**

```
HIGH_RISK_NO_GATES: task <id> has risk 'high' but gates is empty
```

---

### 7. GATE_CRITERION_REF — Every criterionId referenced by a gate exists on that task

**What it checks:** When a gate references a `criterionId` — either explicitly via a future schema field or by the naming convention `gateId = criterionId` — that identifier must correspond to an entry in the same task's `acceptanceCriteria` array. The invariant to enforce is: for every gate, the criterionId it is meant to discharge must be declared on that same task. This enforces the `criterionId → gateId → evidenceContract` chain from _FINAL.md decision 7b.

**Failure mode:**

```
UNKNOWN_CRITERION: task <id> gate '<gateId>' references criterionId '<criterionId>' which does not exist on this task
```

---

## Projection to worker v1.0

The planner's internal rich plan (`schemas/plan.schema.json`) is not the format `ai-code-worker` consumes. The `compile` step projects a subset of the plan into the worker v1.0 manifest format. This projection is **intentionally lossy**, and the loss must be **validated and reported explicitly** by the compile step — not silently dropped.

### acceptanceCriteria projection

`schemas/plan.schema.json` represents `task.acceptanceCriteria` as an array of structured objects:

```json
{ "criterionId": "AC-001", "text": "The output file must be valid JSON." }
```

Worker v1.0's `manifest.schema.json` represents `task.acceptanceCriteria` as a flat array of plain strings.

**Projection rule:** each entry is projected by taking its `text` field only.

```
plan.task.acceptanceCriteria[n] = { "criterionId": "...", "text": "..." }
  → worker.task.acceptanceCriteria[n] = "..."
```

The `criterionId` field does **not** survive into the worker v1.0 export.

### gates projection

`schemas/plan.schema.json` represents `task.gates` as an array of structured objects:

```json
{ "gateId": "G-001", "command": "verify-schema-plan", "evidenceContract": "Exit code 0 and no output to stderr." }
```

Worker v1.0's `manifest.schema.json` represents `task.verify` as a flat array of plain command strings.

**Projection rule:** each entry is projected by taking its `command` field only.

```
plan.task.gates[n] = { "gateId": "...", "command": "...", "evidenceContract": "..." }
  → worker.task.verify[n] = "..."
```

The `gateId` and `evidenceContract` fields do **not** survive into the worker v1.0 export.

### requiredInputs projection

`schemas/plan.schema.json` represents `task.requiredInputs` as typed provenance objects with `kind` and `ref` fields.

**Projection rule:** each entry is projected by taking its `ref` field only, which maps directly onto worker v1.0's flat `requiredInputs` string array.

```
plan.task.requiredInputs[n] = { "kind": "file", "ref": "docs/PHASE-0.md" }
  → worker.task.requiredInputs[n] = "docs/PHASE-0.md"
```

The `kind` discriminant does not survive into the worker v1.0 export.

### relevantSymbols and executionProfile projection

`task.relevantSymbols` and `task.executionProfile` are passed through unchanged **if the worker manifest schema at the target pin supports them**. Compatibility is determined by the matrix in ADR-0005. If the target pin's manifest schema does not declare the field (e.g., `d23d5a0` predates `executionProfile`), the field is dropped with a `projectionWarning`.

### Lossy-projection reporting

The compile step must not silently drop any field. Every field lost during projection must be reported as a `projectionWarning`. This is a required output of the compile step, not an optional annotation.

**Exact reporting shape:**

```json
{
  "projectionWarnings": [
    {
      "taskId": "SCHEMA-PLAN",
      "lostFields": [
        "acceptanceCriteria[0].criterionId",
        "gates[0].gateId",
        "gates[0].evidenceContract"
      ]
    }
  ]
}
```

A compile run with no field loss produces `"projectionWarnings": []`. A run that drops any field and does not emit a corresponding `projectionWarning` entry is a compile defect, not acceptable behaviour.
