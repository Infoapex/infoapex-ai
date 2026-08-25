---
status: accepted
---

# Phase 0 — remaining ADRs, public schemas, linter contract, fixtures

Second dogfooding run of `ai-code-worker` against `ai-code-planner`, this time a multi-task
plan (9 tasks) instead of the single-task pilot (`FINDING-SCHEMA-001`). Closes out every
remaining Phase 0 deliverable listed in `docs/PHASE-0.md`.

## Source of truth

Every task below implements a decision already made and recorded in
`Plan/Architect/_FINAL.md` (rev. 5) in the consumer project planning repository. Tasks do not
invent new product decisions — they formalize decisions §2, §3, §7.10, decision 3 (of §2),
and decision 13 (of §7bis) into ADRs, schemas, a linter contract document, and fixtures.
Where a task references "§X", that is `Plan/Architect/_FINAL.md` §X.

`schemas/finding.schema.json` already exists (`FINDING-SCHEMA-001`, first dogfooding run) —
tasks below may read but must not modify it.

## Task

```ai-code-worker-plan
{
  "goal": "Close out Phase 0: the 4 remaining ADRs, the 3 remaining public schemas, the linter contract document, and fixtures (valid + invalid manifests).",
  "tasks": [
    {
      "id": "ADR-0002-PLAN-MANIFEST-OWNERSHIP",
      "kind": "docs",
      "role": "Write docs/adr/0002-plan-and-manifest-ownership.md.",
      "dependsOn": [],
      "requiredInputs": [
        "README.md",
        "docs/PHASE-0.md",
        "docs/adr/0001-per-task-routing-contract.md"
      ],
      "allowedPaths": [
        "docs/adr/0002-plan-and-manifest-ownership.md"
      ],
      "forbiddenPaths": [
        "docs/adr/0001-per-task-routing-contract.md",
        "schemas/",
        "src/",
        ".ai-code-worker/",
        ".ai-code-control/",
        "scripts/verify/"
      ],
      "expectedArtifacts": [
        "docs/adr/0002-plan-and-manifest-ownership.md"
      ],
      "acceptanceCriteria": [
        "File exists at docs/adr/0002-plan-and-manifest-ownership.md, follows the same section structure as docs/adr/0001-per-task-routing-contract.md (Status/Date line, Context, Decision, Consequences).",
        "Status is 'accepted', dated 2026-08-16.",
        "Decision states: planner is read-only and never produces the frozen manifest — it emits Plan/<task>.md (accepted-status frontmatter + fenced ai-code-worker-plan JSON block); worker compiles, validates against schemas/manifest.schema.json, and freezes the manifest.",
        "Decision states explicitly which fields only worker may assign, because it owns them at compile time: runId, graphVersion, plan.sha256, base.commit.",
        "Decision references that planner's own internal plan representation is richer than the worker v1.0 export (criterion IDs, gate IDs, typed evidence contracts) and that a projection step reduces it to the worker-compatible subset — cross-reference this to the future schemas/plan.schema.json and to ADR-0002's own scope (ownership boundary, not the projection mechanics, which belong to the linter contract document).",
        "Consequences section states plainly that this ADR does not change ai-code-worker: no code or schema in the ai-code-worker repository is touched by this decision.",
        "No JSON code fences with invalid JSON; the file is valid Markdown (no unclosed fences)."
      ],
      "verify": [
        "verify-adr-0002"
      ],
      "concurrencyKeys": [
        "docs/adr/0002-plan-and-manifest-ownership.md"
      ],
      "risk": "low"
    },
    {
      "id": "ADR-0003-FALLBACK-OWNERSHIP",
      "kind": "docs",
      "role": "Write docs/adr/0003-fallback-ownership.md.",
      "dependsOn": [],
      "requiredInputs": [
        "README.md",
        "docs/PHASE-0.md",
        "docs/adr/0001-per-task-routing-contract.md"
      ],
      "allowedPaths": [
        "docs/adr/0003-fallback-ownership.md"
      ],
      "forbiddenPaths": [
        "docs/adr/0001-per-task-routing-contract.md",
        "schemas/",
        "src/",
        ".ai-code-worker/",
        ".ai-code-control/",
        "scripts/verify/"
      ],
      "expectedArtifacts": [
        "docs/adr/0003-fallback-ownership.md"
      ],
      "acceptanceCriteria": [
        "File exists at docs/adr/0003-fallback-ownership.md, same section structure as ADR-0001.",
        "Status is 'accepted', dated 2026-08-16.",
        "Decision states the fallback lifecycle exactly as decision 4 of _FINAL.md §2: planner proposes an executionProfile with fallbacks -> worker verifies each candidate is available (doctor) -> worker freezes the resolved snapshot at compile time -> worker executes the transitions at runtime.",
        "Decision states explicitly that fallback is NOT permitted as a response to: POLICY_FAILURE, a scope violation (allowedPaths/forbiddenPaths), or a failed deterministic test/verify command. Those outcomes must produce BLOCKED or go through the existing bounded repair cycle, never a silent model swap.",
        "Decision notes this is a different mechanism from ai-code-worker's own --fallback-engine (built 2026-08-16 in ai-code-worker's cli.ts): that one is a pre-run, whole-run doctor-level failover chosen by the human invoking worker directly; this ADR's fallback is a per-task, plan-time-proposed / compile-time-frozen mechanism chosen by planner. Both share the same underlying doctor() availability signal, but are different scopes and different owners.",
        "Consequences section states this ADR does not change ai-code-worker's contract by itself — it constrains how planner will populate the executionProfile.fallbacks field once ADR-0001's schema extension exists.",
        "Valid Markdown, no unclosed fences."
      ],
      "verify": [
        "verify-adr-0003"
      ],
      "concurrencyKeys": [
        "docs/adr/0003-fallback-ownership.md"
      ],
      "risk": "low"
    },
    {
      "id": "ADR-0004-AGENT-RUNNER",
      "kind": "docs",
      "role": "Write docs/adr/0004-agent-runner.md.",
      "dependsOn": [],
      "requiredInputs": [
        "README.md",
        "docs/PHASE-0.md",
        "docs/adr/0001-per-task-routing-contract.md"
      ],
      "allowedPaths": [
        "docs/adr/0004-agent-runner.md"
      ],
      "forbiddenPaths": [
        "docs/adr/0001-per-task-routing-contract.md",
        "schemas/",
        "src/",
        ".ai-code-worker/",
        ".ai-code-control/",
        "scripts/verify/"
      ],
      "expectedArtifacts": [
        "docs/adr/0004-agent-runner.md"
      ],
      "acceptanceCriteria": [
        "File exists at docs/adr/0004-agent-runner.md, same section structure as ADR-0001.",
        "Status is 'accepted', dated 2026-08-15 (this decision was made by the user on that date, per _FINAL.md §7bis decision 13 — the ADR formalizes it, it does not re-decide it).",
        "Context section lists the three options considered in _FINAL.md §7.8 (shared/extracted runtime consumed via CLI-JSON; a worker-side plan-only mode; planner's own adapters) and states which was picked and why: planner's own adapters, because worker is pinned at a specific commit and extracting a shared runtime for a single consumer would serialize the whole project behind a refactor, and because an interface should not be extracted for only one consumer.",
        "Decision states the boundary precisely per decision 13 of _FINAL.md: copying code from worker for similar mechanics (process spawn, timeout, output caps) is permitted; importing worker's TypeScript modules at runtime is not.",
        "Decision states the mandatory shared part explicitly: even with independently-implemented adapters, planner MUST use the same versioned schemas as worker for resolved model identity and usage recording, because planningProvenance (_FINAL.md §7.10) and routing-outcome (_FINAL.md decision 13 of §2) are only meaningful if the numbers are comparable across tools.",
        "Consequences section states this ADR does not change ai-code-worker.",
        "Valid Markdown, no unclosed fences."
      ],
      "verify": [
        "verify-adr-0004"
      ],
      "concurrencyKeys": [
        "docs/adr/0004-agent-runner.md"
      ],
      "risk": "low"
    },
    {
      "id": "ADR-0005-WORKER-COMPAT-MATRIX",
      "kind": "docs",
      "role": "Write docs/adr/0005-worker-compatibility-matrix.md.",
      "dependsOn": [],
      "requiredInputs": [
        "README.md",
        "docs/PHASE-0.md",
        "docs/adr/0001-per-task-routing-contract.md"
      ],
      "allowedPaths": [
        "docs/adr/0005-worker-compatibility-matrix.md"
      ],
      "forbiddenPaths": [
        "docs/adr/0001-per-task-routing-contract.md",
        "schemas/",
        "src/",
        ".ai-code-worker/",
        ".ai-code-control/",
        "scripts/verify/"
      ],
      "expectedArtifacts": [
        "docs/adr/0005-worker-compatibility-matrix.md"
      ],
      "acceptanceCriteria": [
        "File exists at docs/adr/0005-worker-compatibility-matrix.md, same section structure as ADR-0001.",
        "Status is 'accepted', dated 2026-08-16.",
        "Decision states the minimum supported ai-code-worker version is commit d23d5a0 (the consumer project integration pin, per _FINAL.md decision 14 of §2), and that origin/main of ai-code-worker is a candidate for the pin to move to, never an automatic upgrade.",
        "Decision states that moving the pin requires an explicit compatibility review, and that until such a review happens, planner's own contract tests (once they exist, from Phase 1 onward) must cover both the pinned commit's manifest.schema.json shape and the current candidate's shape, so a real drift is caught rather than assumed away.",
        "Decision explicitly notes today's actual state as of 2026-08-16: the ai-code-worker repository used for dogfooding in this same consumer project session is a standalone HEAD clone that has moved past d23d5a0 (most recently to include cross-engine review and --fallback-engine, commit a6036ea) — this ADR does not resolve whether that HEAD becomes the new pin; it only states the review process required before any pin change, consistent with decision 14 not being re-opened here.",
        "Includes a short table: Field | Minimum (d23d5a0) | Candidate (current origin/main) | Compatible? — at minimum listing schemaVersion, whether executionProfile exists yet (no, in both, until ADR-0001's extension lands in worker), and testedVersionRanges presence in project-config.schema.json.",
        "Valid Markdown, no unclosed fences, valid Markdown table syntax."
      ],
      "verify": [
        "verify-adr-0005"
      ],
      "concurrencyKeys": [
        "docs/adr/0005-worker-compatibility-matrix.md"
      ],
      "risk": "low"
    },
    {
      "id": "SCHEMA-PLAN",
      "kind": "contract",
      "role": "Define schemas/plan.schema.json: planner's rich internal plan representation.",
      "dependsOn": [],
      "requiredInputs": [
        "README.md",
        "docs/PHASE-0.md",
        "schemas/finding.schema.json"
      ],
      "allowedPaths": [
        "schemas/plan.schema.json"
      ],
      "forbiddenPaths": [
        "schemas/finding.schema.json",
        "docs/",
        "src/",
        ".ai-code-worker/",
        ".ai-code-control/",
        "scripts/verify/"
      ],
      "expectedArtifacts": [
        "schemas/plan.schema.json"
      ],
      "acceptanceCriteria": [
        "schemas/plan.schema.json exists, is valid JSON Schema draft 2020-12 ($schema, $id, additionalProperties: false throughout, matching the style of schemas/finding.schema.json).",
        "Top level requires: goal, tasks. Optional: nonGoals, ambiguities, planningProvenance (a $ref to ./planning-provenance.schema.json if present; if planning-provenance.schema.json does not exist yet at authoring time, define planningProvenance inline as an object with additionalProperties: true and a description noting it will be tightened to a $ref once schemas/planning-provenance.schema.json exists in the same directory).",
        "Each task in tasks[] requires: id, goal, acceptanceCriteria (array of objects, each with a stable criterionId and text, not bare strings -- this is the richer contract per _FINAL.md 7b, distinct from worker v1.0's flat string array), gates (array of objects, each with a stable gateId, a command, and an evidenceContract describing what proves the gate passed), dependsOn (array of task ids), scope (object with allowedPaths and forbiddenPaths arrays), requiredInputs (array of objects, each with a typed provenance: at minimum a kind enum like 'file' | 'symbol' | 'external', and a ref string -- not bare path strings, per decision 10 of _FINAL.md section 2, pointers are frozen, content is resolved at execution).",
        "Optional per-task field: executionProfile (string) -- the logical profile name from ADR-0001, e.g. 'backend-balanced-v1'. Optional per-task field: relevantSymbols (array of strings).",
        "Includes a top-level or per-task risk field using the same enum worker uses (low, medium, high) so the projection to worker v1.0 is lossless on this field.",
        "The schema's description fields must state, in at least the top-level description, that this is the planner-internal rich schema and is NOT the format worker consumes -- worker consumes the projected subset described in schemas/../docs/LINTER-CONTRACT.md (referenced by name, since that file may not exist yet at the time this task runs)."
      ],
      "verify": [
        "verify-schema-plan"
      ],
      "concurrencyKeys": [
        "schemas/plan.schema.json"
      ],
      "risk": "medium"
    },
    {
      "id": "SCHEMA-PLANNING-PROVENANCE",
      "kind": "contract",
      "role": "Define schemas/planning-provenance.schema.json per _FINAL.md section 7.10.",
      "dependsOn": [],
      "requiredInputs": [
        "README.md",
        "docs/PHASE-0.md",
        "schemas/finding.schema.json"
      ],
      "allowedPaths": [
        "schemas/planning-provenance.schema.json"
      ],
      "forbiddenPaths": [
        "schemas/finding.schema.json",
        "docs/",
        "src/",
        ".ai-code-worker/",
        ".ai-code-control/",
        "scripts/verify/"
      ],
      "expectedArtifacts": [
        "schemas/planning-provenance.schema.json"
      ],
      "acceptanceCriteria": [
        "schemas/planning-provenance.schema.json exists, valid JSON Schema draft 2020-12, same style as schemas/finding.schema.json.",
        "Required top-level fields, matching the exact example in _FINAL.md section 7.10: mode (enum: single-agent, panel), topology (enum: sequential-review, blind-parallel, adversarial, arbiter -- allow null or omit when mode is single-agent, document this), panelMembers (array of objects, each requiring id, role, resolvedModel, policyVersion -- resolvedModel is required and must be described as the effective model identifier, not an alias, per the explicit warning in _FINAL.md section 7.10), roundsUsed (integer, minimum 0), roundsAllowed (integer, minimum 1), outcome (enum: CONSENSUS, CONSENSUS_WITH_DISSENT, HUMAN_DECISION_REQUIRED, INVALID_PLAN -- the four terminal states from _FINAL.md section 7.6), findings (object requiring total, verified, refuted, acceptedAsAssumption, needsHuman, all non-negative integers), openDissents (array of strings, finding IDs), planningCostUsd (number, minimum 0), planningDurationSec (number, minimum 0).",
        "additionalProperties: false at every object level.",
        "A short top-level description references that this record must be attached to the frozen plan for auditability, per _FINAL.md section 7.10."
      ],
      "verify": [
        "verify-schema-planning-provenance"
      ],
      "concurrencyKeys": [
        "schemas/planning-provenance.schema.json"
      ],
      "risk": "low"
    },
    {
      "id": "SCHEMA-EXECUTION-PROFILE",
      "kind": "contract",
      "role": "Define schemas/execution-profile.schema.json per ADR-0001 and _FINAL.md decision 3 of section 2.",
      "dependsOn": [],
      "requiredInputs": [
        "README.md",
        "docs/PHASE-0.md",
        "docs/adr/0001-per-task-routing-contract.md",
        "schemas/finding.schema.json"
      ],
      "allowedPaths": [
        "schemas/execution-profile.schema.json"
      ],
      "forbiddenPaths": [
        "schemas/finding.schema.json",
        "docs/",
        "src/",
        ".ai-code-worker/",
        ".ai-code-control/",
        "scripts/verify/"
      ],
      "expectedArtifacts": [
        "schemas/execution-profile.schema.json"
      ],
      "acceptanceCriteria": [
        "schemas/execution-profile.schema.json exists, valid JSON Schema draft 2020-12, same style as schemas/finding.schema.json.",
        "Defines two shapes in the same file (e.g. via two named definitions under $defs, or two top-level schemas with distinct $id fragments -- author's choice, but both must exist and be independently referenceable): (1) the logical profile as it appears in a plan -- a single required string field, e.g. 'name' or 'profile', matching the ADR-0001 example '\"executionProfile\": \"backend-balanced-v1\"' (document that in a plan this may appear as a bare string, not just an object); (2) the resolved snapshot as it appears after worker compiles the plan -- required fields: engine, resolvedModel, fallbacks (array of strings, each a resolvable engine identifier), reason (string), confidence (number, 0 to 1 inclusive), policyVersion (string) -- these six fields are taken verbatim from ADR-0001's decision text and from _FINAL.md decision 3 of section 2.",
        "additionalProperties: false on both shapes.",
        "engine's value space in the resolved snapshot should be documented (description field) as matching whatever engines ai-code-worker's own doctor supports (today: claude, codex) without hard-coding an enum that would need to change every time worker adds an engine -- use type: string with a description explaining the intended value space, not a closed enum.",
        "resolvedModel's description states explicitly it must be the effective model identifier, never an alias like 'claude' or 'codex' alone -- same rule as planningProvenance's panelMembers[].resolvedModel, for the same reason (comparable routing-outcome data, per _FINAL.md decision 13 of section 2)."
      ],
      "verify": [
        "verify-schema-execution-profile"
      ],
      "concurrencyKeys": [
        "schemas/execution-profile.schema.json"
      ],
      "risk": "low"
    },
    {
      "id": "LINTER-CONTRACT",
      "kind": "docs",
      "role": "Write docs/LINTER-CONTRACT.md: the deterministic linter's checks and the worker v1.0 projection rule.",
      "dependsOn": [
        "SCHEMA-PLAN"
      ],
      "requiredInputs": [
        "README.md",
        "docs/PHASE-0.md",
        "schemas/plan.schema.json"
      ],
      "allowedPaths": [
        "docs/LINTER-CONTRACT.md"
      ],
      "forbiddenPaths": [
        "schemas/",
        "docs/adr/",
        "src/",
        ".ai-code-worker/",
        ".ai-code-control/",
        "scripts/verify/"
      ],
      "expectedArtifacts": [
        "docs/LINTER-CONTRACT.md"
      ],
      "acceptanceCriteria": [
        "docs/LINTER-CONTRACT.md exists and documents every deterministic check listed in _FINAL.md decision 7 of section 2, each as its own subsection with: a name, what it checks, and its exact failure mode/message format (e.g. 'CYCLIC_DEPENDENCY: task <id> participates in a dependency cycle: <path>').",
        "Checks documented, at minimum: DAG is acyclic; every dependsOn id refers to a task that exists in the same plan; every requiredInputs entry has a typed provenance (kind + ref, per schemas/plan.schema.json); scope-uri run in parallel (same wave) have no uncontrolled overlap in allowedPaths; allowedPaths intersect forbiddenPaths is empty per task; risk: high implies a non-empty gates array (verify must not be empty for high-risk tasks); every acceptanceCriteria[].criterionId referenced by a gate actually exists on that task (criterionId -> gateId -> evidence contract, per _FINAL.md decision 7b).",
        "A dedicated section titled exactly 'Projection to worker v1.0' documents the projection rule from _FINAL.md decision 7b precisely: schemas/plan.schema.json's rich task.acceptanceCriteria (array of {criterionId, text}) projects to worker v1.0 manifest.schema.json's task.acceptanceCriteria (array of plain strings) by taking each entry's text; schemas/plan.schema.json's rich task.gates (array of {gateId, command, evidenceContract}) projects to worker v1.0's task.verify (array of plain command strings) by taking each entry's command.",
        "States explicitly, per _FINAL.md decision 7b, that this projection is lossy (criterionId, gateId, and evidenceContract do not survive into the worker v1.0 export) and that the loss MUST be validated and reported explicitly by the compile step -- not silently dropped. Document the exact reporting shape as a small JSON example, e.g. { \"projectionWarnings\": [ { \"taskId\": \"...\", \"lostFields\": [\"acceptanceCriteria[0].criterionId\", \"gates[0].evidenceContract\"] } ] }.",
        "States that requiredInputs.ref values (not the typed provenance envelope) project directly onto worker v1.0's flat requiredInputs string array, and that relevantSymbols and executionProfile pass through unchanged if worker's manifest schema at the target pin supports them, or are dropped with a projectionWarning if it does not (cross-reference ADR-0005's compatibility matrix for how to know which pin supports what).",
        "Valid Markdown, no unclosed fences."
      ],
      "verify": [
        "verify-linter-contract"
      ],
      "concurrencyKeys": [
        "docs/LINTER-CONTRACT.md"
      ],
      "risk": "medium"
    },
    {
      "id": "FIXTURES",
      "kind": "test",
      "role": "Add fixtures/: one valid worker v1.0 manifest, one invalid manifest per linter rule from docs/LINTER-CONTRACT.md.",
      "dependsOn": [
        "LINTER-CONTRACT",
        "SCHEMA-PLAN"
      ],
      "requiredInputs": [
        "README.md",
        "docs/PHASE-0.md",
        "docs/LINTER-CONTRACT.md",
        "schemas/plan.schema.json"
      ],
      "allowedPaths": [
        "fixtures/**"
      ],
      "forbiddenPaths": [
        "schemas/",
        "docs/adr/",
        "docs/LINTER-CONTRACT.md",
        "src/",
        ".ai-code-worker/",
        ".ai-code-control/",
        "scripts/verify/"
      ],
      "expectedArtifacts": [
        "fixtures/valid/worker-v1.manifest.json",
        "fixtures/invalid/README.md"
      ],
      "acceptanceCriteria": [
        "fixtures/valid/worker-v1.manifest.json exists, is valid JSON, and validates against ai-code-worker's schemas/manifest.schema.json as it exists at the d23d5a0 pin (reproduce the shape by hand from the manifest.schema.json contents already known from this session's work on ai-code-worker and from FINDING-SCHEMA-001's own task shape -- do not invent fields not present in that schema). It must be a plausible small real plan (2-3 tasks, at least one dependency edge, valid budgets object).",
        "fixtures/invalid/ contains one JSON file per deterministic linter rule documented in docs/LINTER-CONTRACT.md, named after the rule's failure mode (e.g. fixtures/invalid/cyclic-dependency.json, fixtures/invalid/unknown-depends-on.json, fixtures/invalid/scope-overlap.json, fixtures/invalid/paths-intersect.json, fixtures/invalid/high-risk-empty-verify.json, fixtures/invalid/dangling-criterion-id.json). Every rule named in docs/LINTER-CONTRACT.md's checklist must have exactly one corresponding fixture file.",
        "fixtures/invalid/README.md exists and is a short index: one line per fixture file, naming which linter rule it is designed to trip and why the JSON is invalid under that rule specifically (not invalid for some unrelated reason like malformed JSON).",
        "Every file in fixtures/invalid/ other than README.md is syntactically valid JSON on its own (the point is a semantic/structural rule violation the linter should catch once it exists in Phase 1, not a JSON parse error).",
        "fixtures/valid/worker-v1.manifest.json's tasks[].kind, tasks[].risk values are drawn only from the enums already confirmed in ai-code-worker's schemas/manifest.schema.json (kind: contract, backend, frontend, database, docs, test, review, repair, other; risk: low, medium, high)."
      ],
      "verify": [
        "verify-fixtures"
      ],
      "concurrencyKeys": [
        "fixtures/**"
      ],
      "risk": "low"
    }
  ],
  "globalGates": [
    "json-parse"
  ],
  "budgets": {
    "maximumParallelWriters": 2,
    "maximumRepairCycles": 2,
    "maximumTaskMinutes": 25,
    "maximumRunMinutes": 150,
    "maximumAgentInvocations": 30,
    "maximumRunInputUncachedTokens": 3000000,
    "maximumRunCacheReadTokens": 4000000,
    "maximumRunCacheWriteTokens": 3000000,
    "maximumRunOutputTokens": 500000,
    "maximumRunCostUsd": 30,
    "onUnknownUsage": "warn"
  }
}
```
