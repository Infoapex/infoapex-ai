# ADR-0005 - memory-brief is mandatory before any non-trivial task

**Status:** Accepted
**Date:** 2026-04-30

## Context

Without context, agents repeat past mistakes, ignore established decisions, and miss known risks.

## Decision

Before any non-trivial code change, run:

```bash
dotnet run --project tools/ai-code-control/src/AiCodeControl.Cli -- memory-brief "<task description>"
```

"Non-trivial" means anything that modifies more than one file or touches a symbol used elsewhere.

## Consequences

- Agent starts each task with relevant decisions, previous task summaries, and current constraints.
- `memory-brief` is context only — it does not replace `impact-analysis` for code facts.
- If memory is empty (`ItemsIndexed = 0`), the brief still provides the current constraints section.
- After completing a task, create a summary: `memory-add-task-summary --title "<title>" --from-current-git-diff` and run `memory-ingest`.

## Workflow sequence

```
memory-brief "<task>"        → load context
find-symbol <symbol>         → locate target
impact-analysis <symbol>     → assess blast radius
[implement]
verify-changed-files         → scope check
run-validation               → lint/type/test
memory-add-task-summary      → record what happened
memory-ingest                → update index
```
