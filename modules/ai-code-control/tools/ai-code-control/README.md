# AI Code Control - CLI

Full toolkit documentation: [repository root README](../../README.md).
CLI contract for agents (JSON shapes, exit codes): [CLAUDE.md](../../CLAUDE.md).
MCP connection guide: [CONNECT.md](CONNECT.md).

## Commands

```bash
dotnet run --project src/AiCodeControl.Cli -- init [--template dotnet-nextjs|python-rust|generic]
dotnet run --project src/AiCodeControl.Cli -- health-check
dotnet run --project src/AiCodeControl.Cli -- run-validation
dotnet run --project src/AiCodeControl.Cli -- index-python --path .
dotnet run --project src/AiCodeControl.Cli -- index-rust --path .
dotnet run --project src/AiCodeControl.Cli -- index-code --path . [--full]
dotnet run --project src/AiCodeControl.Cli -- obsidian-export [--path <scope>] [--out <vault>] [--include-symbols] [--max-symbols <n>]
dotnet run --project src/AiCodeControl.Cli -- find-symbol <query>
dotnet run --project src/AiCodeControl.Cli -- impact-analysis <symbol> [--depth 5]
dotnet run --project src/AiCodeControl.Cli -- verify-changed-files --plan .ai-code-control/reports/refactor/current-plan.json
dotnet run --project src/AiCodeControl.Cli -- refactor-guard --plan .ai-code-control/reports/refactor/current-plan.json
dotnet run --project src/AiCodeControl.Cli -- memory-init
dotnet run --project src/AiCodeControl.Cli -- memory-ingest
dotnet run --project src/AiCodeControl.Cli -- memory-prune
dotnet run --project src/AiCodeControl.Cli -- memory-search <query> [--limit <n>]
dotnet run --project src/AiCodeControl.Cli -- memory-brief [task]
dotnet run --project src/AiCodeControl.Cli -- memory-health [--fail-on-stale]
dotnet run --project src/AiCodeControl.Cli -- memory-add-task-summary --title "<title>" --from-current-git-diff
dotnet run --project src/AiCodeControl.Cli -- refresh [--path .] [--full]
```

Exit codes: `0` = pass, `1` = usage/config error, `2` = check failed.

---

## Refactor-plan workflow (`current-plan.json`)

### 1. Define the plan for the task

Create or update `.ai-code-control/reports/refactor/current-plan.json`:

```json
{
  "task": "Rename OrderService to CheckoutService",
  "language": "csharp",
  "affectedSymbol": "MyApp.Application.Orders.OrderService",
  "allowedFiles": [
    "api/MyApp.Application/Orders/OrderService.cs",
    "api/MyApp.Api/Controllers/OrdersController.cs",
    "api/MyApp.Tests.Unit/Orders/OrderServiceTests.cs"
  ],
  "forbiddenPaths": [
    "web/node_modules/",
    "api/Migrations/",
    "generated/"
  ],
  "allowedUntrackedPatterns": [
    ".ai-code-control/memory/"
  ],
  "requiredValidation": ["run-validation"],
  "riskLevel": "medium"
}
```

| Field | Role |
|-------|------|
| `allowedFiles` | Exact files that may change. Anything else = `unexpectedFiles` = fail. |
| `allowedPatterns` | Glob-scoped files that may change. |
| `forbiddenPaths` | Paths that must never be touched (generated code, migrations, secrets). |
| `allowedUntrackedPatterns` | Prefixes for intentional new (untracked) files. |
| `riskLevel` | `low` / `medium` / `high`. |

Active manifests in `.ai-code-control/tasks/` are checked for overlapping scopes.
An active task with no explicit scope fails closed.

### 2. Install the pre-commit hook (once)

```powershell
./install-hook.ps1            # -Uninstall to remove, -Force to overwrite
```

Every `git commit` then runs `verify-changed-files`; violations block the commit.
With no active plan (`allowedFiles` empty), the hook passes silently.

### 3. Verify manually before committing

```bash
dotnet run --project src/AiCodeControl.Cli -- verify-changed-files
```

Generated artifacts (`bin/`, `obj/`, `node_modules/`, `.next/`, `dist/`, `coverage/`,
`target/`, `__pycache__/`, ...) are filtered automatically and reported in
`filteredArtifactsCount`.

### 4. Run the full guard (verify + validation)

```bash
dotnet run --project src/AiCodeControl.Cli -- refactor-guard
```

### 5. After finishing the task

```bash
dotnet run --project src/AiCodeControl.Cli -- memory-add-task-summary --title "Rename OrderService" --from-current-git-diff
dotnet run --project src/AiCodeControl.Cli -- memory-ingest
```

Then reset `current-plan.json` (`"task": "none", "allowedFiles": []`) or write the
next task's plan.

---

## Validation toolchains

`run-validation` executes the toolchains from `.ai-code-control/config/code-control.json`
(see ADR-0009). Each toolchain is a name + working directory + ordered commands with
timeouts. Failed commands include their captured output so the agent can see why.

---

## Build and test

```bash
dotnet build AiCodeControl.sln
dotnet test AiCodeControl.sln
```
