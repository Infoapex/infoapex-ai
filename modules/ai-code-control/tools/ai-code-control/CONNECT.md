# AI Code Control - MCP Connection Guide

How to connect the AI Code Control MCP server to Claude Code and other MCP-compatible clients.

---

## What the MCP server exposes

| Tool | Description |
|------|-------------|
| `find_symbol` | Locate a symbol (function, class, method) in the code graph |
| `impact_analysis` | Transitive blast radius; ambiguous names must be qualified |
| `run_validation` | Run the configured validation toolchains (code-control.json) |
| `verify_changed_files` | Check git-changed files against the active plan |
| `refactor_guard` | verify_changed_files + run_validation in one call |
| `health_check` | Databases present, files/symbols indexed, toolchains configured |
| `index_code` | Incremental C#/TypeScript/JavaScript/SQL index; optional full rebuild |
| `index_python` / `index_rust` | Compatibility indexers for Python/Rust |
| `refresh_context` | Refresh memory and the incremental codegraph together |
| `memory_search` | Search persistent memory by keyword (diacritics-insensitive, OR + BM25) |
| `memory_brief` | Context brief for a task (ADRs, past summaries, excerpts) |
| `memory_health` | Memory database status |
| `memory_init` | Initialize memory database and markdown skeleton |
| `memory_ingest` | Rebuild memory index from markdown sources (prunes orphans) |
| `memory_prune` | Remove index entries whose source files are gone |
| `memory_add_task_summary` | Record a completed-task summary into memory |

Failed CLI calls return `isError: true`; exit code 2 (a failed check) is returned as a
normal result for the model to read. Tool calls time out after 300s by default
(override with the `ACC_TOOL_TIMEOUT_MS` env var).

---

## Prerequisites

1. **.NET 9 SDK** installed. Publishing the CLI is optional but improves startup:
   ```bash
   dotnet publish tools/ai-code-control/src/AiCodeControl.Cli -c Release -o tools/ai-code-control/bin/publish
   ```
   The server prefers a native executable, then a published DLL, then falls back to
   `dotnet run --project ...` when no publish output exists.

2. **Node.js 20+** installed.

3. **MCP server built** - run once from `tools/ai-code-control/mcp-server/`:
   ```bash
   npm ci
   npm run build
   ```

---

## Connecting to Claude Code (.mcp.json)

Claude Code reads project-scope MCP servers from `.mcp.json` at the repo root
(note: the file is `.mcp.json`, not `claude.json`):

```json
{
  "mcpServers": {
    "ai-code-control": {
      "command": "node",
      "args": ["tools/ai-code-control/mcp-server/dist/server.js"],
      "env": { "REPO_ROOT": "." }
    }
  }
}
```

Alternatively: `claude mcp add ai-code-control -- node tools/ai-code-control/mcp-server/dist/server.js`

Restart Claude Code; the tools appear in the MCP tools panel.

---

## Connecting to Claude Desktop (claude_desktop_config.json)

Config file location:
- Windows: `%APPDATA%\Claude\claude_desktop_config.json`
- macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`

Use absolute paths (replace `<repo-root>` with your repository path):

```json
{
  "mcpServers": {
    "ai-code-control": {
      "command": "node",
      "args": ["<repo-root>/tools/ai-code-control/mcp-server/dist/server.js"],
      "env": { "REPO_ROOT": "<repo-root>" }
    }
  }
}
```

---

## Connecting to other MCP clients (Codex, etc.)

Any client supporting stdio transport works. Pass:

- **command**: `node`
- **args**: `["<repo-root>/tools/ai-code-control/mcp-server/dist/server.js"]`
- **env**: `{ "REPO_ROOT": "<repo-root>" }`

---

## Development (without building)

Run the server directly from source with `tsx` (slower startup, no build step):

```json
{
  "mcpServers": {
    "ai-code-control": {
      "command": "npx",
      "args": ["tsx", "tools/ai-code-control/mcp-server/src/server.ts"],
      "env": { "REPO_ROOT": "." }
    }
  }
}
```

---

## Troubleshooting

| Symptom | Fix |
|---------|-----|
| `ENOENT` on CLI binary | Run `dotnet publish` (see Prerequisites) |
| Tools return empty output | Check `REPO_ROOT` points to the repo root |
| `memory_health` shows 0 items | Run the `memory_ingest` tool to rebuild the index |
| Build fails (`tsc` not found) | Run `npm ci` inside `mcp-server/` |
| Tool call hangs then errors | Long validation - raise `ACC_TOOL_TIMEOUT_MS` |
