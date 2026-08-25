# Invalid fixtures index

Each file in this directory is syntactically valid JSON that violates exactly one deterministic linter rule from `docs/LINTER-CONTRACT.md`. These fixtures are designed to be caught by the linter in Phase 1, not rejected at JSON parse time.

| File | Linter rule (error code) | Why it is invalid |
|---|---|---|
| `cyclic-dependency.json` | `DAG_ACYCLIC` → `CYCLIC_DEPENDENCY` | TASK-A depends on TASK-B and TASK-B depends on TASK-A, forming a cycle in the dependency graph. |
| `unknown-depends-on.json` | `DEPENDENCY_EXISTS` → `UNKNOWN_DEPENDENCY` | TASK-A's `dependsOn` lists `TASK-DOES-NOT-EXIST`, which is not present anywhere in the plan. |
| `untyped-input.json` | `REQUIRED_INPUTS_TYPED` → `UNTYPED_INPUT` | TASK-A has a `requiredInputs` entry `{ "ref": "docs/PHASE-0.md" }` that is missing the required `kind` discriminant (`"file"`, `"symbol"`, or `"external"`). |
| `scope-overlap.json` | `SCOPE_NO_UNCONTROLLED_OVERLAP` → `SCOPE_OVERLAP` | TASK-A and TASK-B are in the same execution wave (neither depends on the other) and both list `src/shared/**` in their `allowedPaths`, creating an uncontrolled write-domain race. |
| `paths-intersect.json` | `SCOPE_NO_SELF_INTERSECTION` → `SCOPE_SELF_INTERSECTION` | TASK-A lists `src/shared/**` in both `allowedPaths` and `forbiddenPaths` simultaneously, which is self-contradictory. |
| `high-risk-empty-verify.json` | `HIGH_RISK_REQUIRES_GATES` → `HIGH_RISK_NO_GATES` | TASK-A has `risk: "high"` but its `gates` array is empty; every high-risk task must declare at least one verification gate. |
| `dangling-criterion-id.json` | `GATE_CRITERION_REF` → `UNKNOWN_CRITERION` | TASK-A has a gate with `gateId: "AC-999"`, but `"AC-999"` does not appear as a `criterionId` in the task's `acceptanceCriteria` (which only contains `"AC-001"`). By the `gateId = criterionId` naming convention, this gate references a non-existent criterion. |
