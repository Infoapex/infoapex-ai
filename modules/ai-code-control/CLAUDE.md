# AI Code Control - CLI contract for agents

This repository ships a CLI + MCP toolset that gives you persistent memory and code
discipline. Use it instead of re-researching the codebase.

## Invocation

Published binary (preferred): `tools/ai-code-control/bin/publish/AiCodeControl.Cli(.exe)`
or `dotnet tools/ai-code-control/bin/publish/AiCodeControl.Cli.dll <command>`.
From source: `dotnet run --project tools/ai-code-control/src/AiCodeControl.Cli -- <command>`.
Over MCP: same commands as tools (see tools/ai-code-control/CONNECT.md).

## Exit codes (all commands)

- `0` = success / check passed
- `1` = usage or configuration error (message in JSON `status: "error"`)
- `2` = check failed (validation, scope violations) - read the JSON for details

All commands print a single JSON object to stdout, except `memory-brief` which prints markdown.

## Commands

| Command | Output (key fields) |
|---------|---------------------|
| `init [--template dotnet-nextjs\|python-rust\|generic]` | `createdFiles`, `skippedExistingFiles`; creates both SQLite DBs. Never overwrites existing configs |
| `health-check` | database status, codegraph counts by language, last index run, configured toolchains |
| `run-validation` | `status` pass/fail, `results[]` per toolchain command (`name`, `status`, `exitCode`, `durationMs`, `error`, `output` on failure) |
| `index-python --path <p>` / `index-rust --path <p>` | counts of files/symbols/references indexed |
| `index-code [--path <p>] [--full]` | incremental C#/TypeScript/JavaScript/SQL indexing; full rebuild when requested |
| `find-symbol <query>` | `symbols[]` with `fullName`, `kind`, `file`, `line` |
| `impact-analysis <full.name> [--depth <n>]` | direct/transitive callers, ambiguity, affected files, `riskLevel` |
| `verify-changed-files [--plan <p>]` | scope, branch and parallel-task conflicts |
| `refactor-guard [--plan <p>]` | verify + validation combined |
| `memory-init` | creates memory DB + markdown skeleton (idempotent) |
| `memory-ingest` | `ingested`, `skipped`, `pruned`, `errors[]`; rebuilds FTS index from markdown |
| `memory-prune` | `pruned` - drops index entries for deleted files |
| `memory-search <query> [--limit <n>]` | `matches[]` with `sourcePath`, `title`, `excerpt`. OR semantics, BM25 ranked, diacritics-insensitive |
| `memory-brief [task]` | markdown brief. With no task: recent-memory mode (for SessionStart hooks) |
| `memory-health [--fail-on-stale]` | changed, unindexed, orphaned and missing canonical sources |
| `memory-tokens [--top <n>]` | estimated token footprint of the store: `totalItems`, `totalTokens`, `byType[]`, `largestItems[]`, plus recent-brief `briefTokens` vs `briefBudget`. Use it to find what dominates the memory budget |
| `memory-add-task-summary --title <t> [--from-current-git-diff]` | creates a task summary skeleton in `.ai-code-control/memory/tasks/` - fill the TODOs, then run `memory-ingest` |
| `refresh [--path <p>] [--full]` | refresh memory and codegraph together |

## Workflow you must follow for non-trivial tasks (ADR-0005)

1. `memory-brief "<task>"` - read the context before editing.
2. `find-symbol` / `impact-analysis` on anything you plan to change.
3. Implement, staying inside `allowedFiles` / `allowedPatterns` of the active task manifest.
4. `verify-changed-files` then `run-validation` - both must pass.
5. `memory-add-task-summary --title "<task>" --from-current-git-diff`, fill it in, then `refresh`.

## Rules

- Markdown under `.ai-code-control/memory/` is the canonical memory; the SQLite DBs are
  derived and disposable (ADR-0006). Never edit the DBs directly.
- Memory is context, not code truth. For "what breaks if I change X" use
  `impact-analysis` (ADR-0004).
- Write all template files, code comments and docs in English ASCII (no diacritics) -
  encoding safety is a project decision. User-authored memory content may contain
  diacritics; search handles them.
- Never reference prior host projects in template content; this is a general-purpose template.
- Configs live in `.ai-code-control/config/`; do not hardcode paths or commands in C#/TS code.
