---
name: ai-code-worker
description: Executes an accepted ai-code-worker plan (Plan/*.md) through the ai-code-worker CLI. Use only when the user explicitly asks to run a plan through ai-code-worker, or asks to implement a plan file that has ai-code-worker-plan frontmatter.
---

# ai-code-worker

This skill is a thin invocation shim (IMPLEMENTATION-PLAN.md §12.1/§12.2) - it does not
implement anything itself and does not hold run state. All orchestration, scope
enforcement, gating, and commit authority belong to the `ai-code-worker` CLI.

Do not start implementation work directly. Instead, run:

```powershell
node ai-code-worker/dist/src/cli.js run <plan-path> --engine <codex|claude>
```

The worker will not activate itself from a plan file's frontmatter alone - it always
requires this explicit invocation. Report the worker's own `DONE`/`BLOCKED` result
verbatim; do not substitute your own judgment about whether the plan succeeded.
