---
status: accepted
---

# Phase 1 — propose / inspect / compile / explain-routing, decomposer, linter runtime, worker v1.0 export

Third dogfooding run of `ai-code-worker` against `ai-code-planner`, and the first that
produces real runtime code (`src/**/*.ts`), not just documents and schemas. Phase 0
(contracts only) is done; this closes Phase 1 per `Plan/Architect/_FINAL.md` §3:
"`propose`, `inspect`, `compile`, `explain-routing`. Decomposer with `fanout=false`.
Deterministic linter. Export worker v1.0. No routing."

Deliberately claude-only, no independent review (no cross-engine review, no repair
loop) at the user's explicit direction on 2026-08-16, to conserve remaining weekly
usage. Each task's own `verify` gate (real TypeScript build + real unit tests) is the
correctness check, same as the strongest gate that already worked cleanly for all 9
Phase 0 tasks.

## Architecture this plan implements

```
ai-code-planner propose "<prompt>" --out <draft.plan.json>
  -> decomposer calls Claude once (fanout=false) -> validates against
     schemas/plan.schema.json -> writes the rich draft plan as JSON

ai-code-planner inspect <draft.plan.json>
  -> schema-validates + runs the deterministic linter -> prints a report,
     does not write anything

ai-code-planner compile <draft.plan.json> --task-id <id> --out Plan/<id>.md
  -> linter MUST pass -> projects the rich plan to the worker v1.0 shape
     (docs/LINTER-CONTRACT.md's projection rule) -> writes Plan/<id>.md
     (frontmatter + fenced ai-code-worker-plan JSON block) - the exact
     artifact ai-code-worker's own `compile` command consumes

ai-code-planner explain-routing <draft.plan.json | Plan/<id>.md>
  -> Phase 1 stub: reports each task's `executionProfile` field as declared
     but UNRESOLVED (routing/resolution is Phase 3, not built here) - never
     invents a resolved engine/model
```

## Source of truth

- `Plan/Architect/_FINAL.md` §2 (decisions 1-10), §3 (phase table) - product decisions.
- `docs/LINTER-CONTRACT.md` - the exact deterministic checks and the projection rule
  this plan implements in real code (built in Phase 0, not re-decided here).
- `schemas/plan.schema.json`, `schemas/finding.schema.json` - the shapes this plan's
  types must mirror exactly (built in Phase 0).
- `fixtures/valid/worker-v1.manifest.json`, `fixtures/invalid/*.json` - the exact test
  fixtures the linter's tests must run against (built in Phase 0 for this purpose).
- `ai-code-worker`'s `src/engines/claude-cli.ts` (`ClaudeCliAdapter`) - the real,
  already-proven `claude -p` invocation shape and JSON-envelope extraction logic.
  Per ADR-0004 / `_FINAL.md` decision 13: copying this MECHANICS is authorized;
  importing the module is not. Task `CLAUDE-ADAPTER` below re-implements it
  independently in this repo.

## Tasks

```ai-code-worker-plan
{
  "goal": "Implement ai-code-planner's Phase 1: propose/inspect/compile/explain-routing CLI, a single-shot (fanout=false) decomposer backed by a planner-owned Claude adapter, a deterministic linter runtime implementing docs/LINTER-CONTRACT.md, and the projection from the rich plan schema to the worker v1.0 export. (TYPES-AND-SCHEMA-VALIDATE already merged into main separately -- see commit history.) (Only CLI remains -- the other 5 tasks are already merged into main.)",
  "tasks": [
    {
      "id": "CLI",
      "kind": "backend",
      "role": "Wire propose/inspect/compile/explain-routing into src/cli.ts.",
      "dependsOn": [],
      "requiredInputs": [
        "src/types.ts",
        "src/schema-validate.ts",
        "src/linter/lint-plan.ts",
        "src/projection/project-to-worker-v1.ts",
        "src/plan-file/write-plan-markdown.ts",
        "src/plan-file/read-plan-markdown.ts",
        "src/decompose/decompose-prompt.ts",
        "src/engine/claude-adapter.ts",
        "package.json"
      ],
      "allowedPaths": [
        "src/cli.ts",
        "tests/unit/cli.test.ts"
      ],
      "forbiddenPaths": [
        "src/types.ts",
        "src/schema-validate.ts",
        "src/linter/",
        "src/projection/",
        "src/plan-file/",
        "src/decompose/",
        "src/engine/",
        "tests/helpers/",
        ".ai-code-worker/",
        ".ai-code-control/",
        "ai-code-control/"
      ],
      "expectedArtifacts": [
        "src/cli.ts",
        "tests/unit/cli.test.ts"
      ],
      "acceptanceCriteria": [
        "src/cli.ts is the entry point matching package.json's bin field (dist/src/cli.js), dispatching on process.argv[2] with a switch/if-chain over: 'propose', 'inspect', 'compile', 'explain-routing' (mirror ai-code-worker's own src/cli.ts style: a readOption(flag) helper reading '--flag value' pairs from argv, a '--json' flag that switches between a JSON.stringify(report) output and a short human-readable console summary, process.exitCode set to 0 on success / 1 on usage error / 2 on a BLOCKED-equivalent report).",
        "'propose <prompt> [--out <path>] [--claude-executable <path>] [--claude-model <model>]': constructs a Claude adapter via createClaudeAdapter using --claude-executable/--claude-model overrides when given (falls back to real 'claude' otherwise), calls decomposePrompt, and on ok:true writes the resulting Plan as pretty JSON to --out (default: `.ai-code-planner/drafts/<slugified-prompt>-<shortId>.plan.json`, creating parent directories as needed). On ok:false, prints the error and sets exitCode 1 (or 2 for --json mode with a BLOCKED-shaped report), writes nothing.",
        "'inspect <draft-path>': reads the JSON file at draft-path, validates it against schemas/plan.schema.json via validateAgainstSchema, and if schema-valid, runs lintPlan on it. Prints a report (JSON with --json: { schemaValid: boolean, schemaErrors: string[], lintOk: boolean, findings: Finding[] }) and writes nothing. Exit code reflects overall pass/fail (0 if schemaValid && lintOk, else 2).",
        "'compile <draft-path> --task-id <id> --out <Plan/path.md> [--base-engine <fake|codex|claude>] [--maximum-parallel-writers <n>] [--maximum-repair-cycles <n>] [--maximum-task-minutes <n>] [--maximum-run-minutes <n>]': reads and schema-validates the draft, runs lintPlan and BLOCKS (does not write anything, exit code 2) if lintOk is false, otherwise runs projectToWorkerV1 and calls writePlanMarkdown with the projected tasks/globalGates and a budgets object assembled from the numeric CLI flags (with reasonable defaults matching the budgets shape already proven in Plan/PHASE-0-FINDING-SCHEMA.md: maximumParallelWriters 1, maximumRepairCycles 2, maximumTaskMinutes 20, maximumRunMinutes 30, maximumAgentInvocations 4, maximumRunInputUncachedTokens/CacheReadTokens/CacheWriteTokens 200000 each, maximumRunOutputTokens 50000, maximumRunCostUsd 2.0, onUnknownUsage 'warn'). Prints the projectionWarnings from the projection step even on success (visible, not silent, per docs/LINTER-CONTRACT.md's requirement that lossy projection is always reported).",
        "'explain-routing <draft-path-or-Plan-md-path>': reads either a raw draft JSON (has a top-level 'tasks' array of rich PlanTask) or a compiled Plan/<id>.md (has the ai-code-worker-plan block with WorkerManifestTask[] that may carry a passthrough executionProfile field) -- detect which by trying JSON.parse first, falling back to reading it via readPlanMarkdown. For each task, prints its id and, if executionProfile is set, the profile name with the fixed note 'declared, not resolved -- routing/resolution is implemented in Phase 3, not Phase 1'; if unset, prints 'no executionProfile declared'. NEVER outputs a resolved engine, model, or confidence value -- Phase 1 must not simulate or guess routing.",
        "tests/unit/cli.test.ts is a subprocess-level test (execFileSync(process.execPath, [resolve('dist/src/cli.js'), ...args], { encoding: 'utf8' }), tolerating non-zero exit and reading stdout even on error -- mirror ai-code-worker's own tests/unit/cli-executable-flags.test.ts pattern) covering at least: (1) propose with a fake --claude-executable produces a draft file that inspect reports as schemaValid+lintOk; (2) compile on that draft produces a Plan/<id>.md whose fenced ai-code-worker-plan block is valid JSON and matches schemas/manifest.schema.json's task-level required fields (id, kind, role, dependsOn, requiredInputs, allowedPaths, forbiddenPaths, expectedArtifacts, acceptanceCriteria, verify, concurrencyKeys, risk) for every task -- do NOT validate against ai-code-worker's manifest.schema.json file directly (this repo does not depend on ai-code-worker's schema file), instead assert the required key names are present by hand, matching the same list docs/LINTER-CONTRACT.md documents; (3) inspect on a draft with a real DAG cycle reports lintOk:false with a finding naming the cycle; (4) explain-routing never prints a resolved model/engine string, only the fixed unresolved note."
      ],
      "verify": [
        "build",
        "test-cli"
      ],
      "concurrencyKeys": [
        "src/cli.ts"
      ],
      "risk": "high"
    }
  ],
  "globalGates": [
    "json-parse"
  ],
  "budgets": {
    "maximumParallelWriters": 2,
    "maximumRepairCycles": 0,
    "maximumTaskMinutes": 40,
    "maximumRunMinutes": 240,
    "maximumAgentInvocations": 10,
    "maximumRunInputUncachedTokens": 6000000,
    "maximumRunCacheReadTokens": 6000000,
    "maximumRunCacheWriteTokens": 3000000,
    "maximumRunOutputTokens": 800000,
    "maximumRunCostUsd": 60,
    "onUnknownUsage": "warn"
  }
}
```
