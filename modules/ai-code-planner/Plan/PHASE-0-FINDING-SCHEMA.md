---
status: accepted
---

# Phase 0 — finding.schema.json

First real dogfooding run of `ai-code-worker` against `ai-code-planner`. Deliberately a single, small task: validate that the compile → run → gate → commit pipeline works end to end on this repo before committing to a larger multi-task plan.

## Goal

Produce `schemas/finding.schema.json` — the structured-finding contract described in `Plan/Architect/_FINAL.md` §7.3 of the consumer project planning repository. This schema is used by the deterministic linter now, and by the consensus panel later (Phase 4+), so it must be designed first: every other Phase 0 schema and the linter contract will reference it.

## Required shape

The finding record must support, at minimum, the fields from the design record's example:

```json
{
  "id": "F-003",
  "authorAgent": "claude-planner",
  "type": "unverified-claim",
  "severity": "major",
  "target": "plan#phase-2",
  "claim": "relevantSymbols lipseste din contractul worker minim",
  "verification": {
    "method": "repository-query",
    "intent": "check-schema-property",
    "inputs": { "revision": "d23d5a0", "schema": "schemas/manifest.schema.json", "property": "relevantSymbols" },
    "expected": "absent"
  },
  "status": "proposed"
}
```

- `type` must be an enum covering at least: `unverified-claim`, `internal-contradiction`, `omission`, `over-claim`, `style`.
- `severity` must be an enum: `blocker`, `major`, `minor`.
- `status` must be an enum: `proposed`, `verified`, `refuted`, `accepted-as-assumption`, `needs-human`, `superseded`.
- `verification.method` must distinguish safe, structured verification (e.g. `repository-query`, `schema-check`) from anything resembling raw shell execution — per the security correction in `_FINAL.md` §7.4, raw LLM-generated shell commands must never be a valid `method` value. Do not include a "command" or "shell" method.
- `verification` must be optional (a finding can be `accepted-as-assumption` with no verification attempted).

Use JSON Schema draft 2020-12, matching the style of `ai-code-worker`'s own schemas (`$schema`, `$id`, `additionalProperties: false`, `required` list).

## Task

```ai-code-worker-plan
{
  "goal": "Produce schemas/finding.schema.json: the structured-finding contract for the ai-code-planner linter and, later, the consensus panel.",
  "tasks": [
    {
      "id": "FINDING-SCHEMA-001",
      "kind": "contract",
      "role": "Define the JSON Schema for a structured planning/linting finding.",
      "dependsOn": [],
      "requiredInputs": ["README.md", "docs/PHASE-0.md"],
      "allowedPaths": ["schemas/finding.schema.json"],
      "forbiddenPaths": ["docs/", "src/", ".ai-code-worker/", ".ai-code-control/"],
      "expectedArtifacts": ["schemas/finding.schema.json"],
      "acceptanceCriteria": [
        "schemas/finding.schema.json exists and is valid JSON Schema (draft 2020-12).",
        "The schema requires: id, type, severity, claim, status.",
        "type is an enum including at least unverified-claim, internal-contradiction, omission, over-claim, style.",
        "severity is an enum: blocker, major, minor.",
        "status is an enum: proposed, verified, refuted, accepted-as-assumption, needs-human, superseded.",
        "verification is optional; when present it never allows a raw shell/command method.",
        "additionalProperties is false at the top level."
      ],
      "verify": ["node -e \"JSON.parse(require('fs').readFileSync('schemas/finding.schema.json','utf8'))\""],
      "concurrencyKeys": ["schemas/finding.schema.json"],
      "risk": "low"
    }
  ],
  "globalGates": ["json-parse"],
  "budgets": {
    "maximumParallelWriters": 1,
    "maximumRepairCycles": 2,
    "maximumTaskMinutes": 20,
    "maximumRunMinutes": 30,
    "maximumAgentInvocations": 4,
    "maximumRunInputUncachedTokens": 200000,
    "maximumRunCacheReadTokens": 200000,
    "maximumRunCacheWriteTokens": 200000,
    "maximumRunOutputTokens": 50000,
    "maximumRunCostUsd": 2.0,
    "onUnknownUsage": "warn"
  }
}
```
