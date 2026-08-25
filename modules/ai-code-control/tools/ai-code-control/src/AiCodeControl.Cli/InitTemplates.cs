namespace AiCodeControl.Cli;

/// <summary>
/// Generates starter config files for a target repository. Files are only
/// written when absent - init never overwrites an existing config.
/// </summary>
public static class InitTemplates
{
    public static readonly string[] Available = { "dotnet-nextjs", "python-rust", "generic" };

    public static (List<string> Created, List<string> Skipped) Apply(string repoRoot, string template)
    {
        var files = template switch
        {
            "dotnet-nextjs" => DotnetNextjs(),
            "python-rust" => PythonRust(),
            "generic" => Generic(),
            _ => throw new ArgumentException(
                $"Unknown template '{template}'. Available: {string.Join(", ", Available)}")
        };

        var created = new List<string>();
        var skipped = new List<string>();

        foreach (var (relativePath, content) in files)
        {
            var fullPath = Path.Combine(repoRoot, relativePath.Replace('/', Path.DirectorySeparatorChar));
            if (File.Exists(fullPath))
            {
                skipped.Add(relativePath);
                continue;
            }

            Directory.CreateDirectory(Path.GetDirectoryName(fullPath)!);
            File.WriteAllText(fullPath, content);
            created.Add(relativePath);
        }

        return (created, skipped);
    }

    private static List<(string Path, string Content)> DotnetNextjs() => new()
    {
        (".ai-code-control/config/code-control.json",
"""
{
  "toolchains": [
    {
      "name": "dotnet",
      "enabled": true,
      "path": "api",
      "commands": [
        { "name": "build", "run": "dotnet build --nologo", "timeoutSeconds": 300 },
        { "name": "test", "run": "dotnet test --nologo --no-build", "timeoutSeconds": 600 }
      ]
    },
    {
      "name": "node",
      "enabled": true,
      "path": "web",
      "commands": [
        { "name": "lint", "run": "npm run lint", "timeoutSeconds": 300 },
        { "name": "typecheck", "run": "npx tsc --noEmit", "timeoutSeconds": 300 },
        { "name": "test", "run": "npm test", "timeoutSeconds": 600 }
      ]
    }
  ],
  "git": {
    "protectedBranches": ["main", "master", "develop", "release"],
    "forbiddenPaths": ["node_modules/", ".next/", "dist/", "bin/", "obj/", "coverage/", ".turbo/", "generated/"]
  },
  "indexing": {
    "database": ".ai-code-control/db/codegraph.sqlite",
    "exclude": ["**/node_modules/**", "**/.next/**", "**/dist/**", "**/bin/**", "**/obj/**", "**/.git/**", "**/coverage/**"]
  },
  "logging": {
    "level": "info",
    "file": ".ai-code-control/reports/tool.log",
    "maxFileSizeMb": 10
  }
}
"""),
        (".ai-code-control/config/memory-control.json", MemoryControlJson),
        (".ai-code-control/reports/refactor/current-plan.json",
"""
{
  "task": "none",
  "language": "csharp",
  "affectedSymbol": "",
  "allowedFiles": [],
  "forbiddenPaths": ["web/node_modules/", "web/.next/", ".ai-code-control/db/"],
  "allowedUntrackedPatterns": [".ai-code-control/memory/"],
  "requiredValidation": ["run-validation"],
  "riskLevel": "low"
}
"""),
        (".mcp.json", McpJson),
        (".claude/settings.json", ClaudeSettingsJson),
        (".codex/config.toml", CodexConfigToml),
        ("AGENTS.md", AgentGuide),
        ("CLAUDE.md", ClaudeBootstrap)
    };

    private static List<(string Path, string Content)> PythonRust() => new()
    {
        (".ai-code-control/config/code-control.json",
"""
{
  "toolchains": [
    {
      "name": "python",
      "enabled": true,
      "path": ".",
      "commands": [
        { "name": "lint", "run": "ruff check .", "timeoutSeconds": 120 },
        { "name": "test", "run": "pytest", "timeoutSeconds": 300 }
      ]
    },
    {
      "name": "rust",
      "enabled": true,
      "path": ".",
      "commands": [
        { "name": "fmt", "run": "cargo fmt --check", "timeoutSeconds": 120 },
        { "name": "check", "run": "cargo check", "timeoutSeconds": 180 },
        { "name": "clippy", "run": "cargo clippy -- -D warnings", "timeoutSeconds": 240 },
        { "name": "test", "run": "cargo test", "timeoutSeconds": 300 }
      ]
    }
  ],
  "git": {
    "protectedBranches": ["main", "master", "develop", "release"],
    "forbiddenPaths": ["__pycache__/", ".venv/", "venv/", "target/", "dist/", "build/", "generated/"]
  },
  "indexing": {
    "database": ".ai-code-control/db/codegraph.sqlite",
    "exclude": ["**/__pycache__/**", "**/.venv/**", "**/venv/**", "**/target/**", "**/dist/**", "**/.git/**"]
  },
  "logging": {
    "level": "info",
    "file": ".ai-code-control/reports/tool.log",
    "maxFileSizeMb": 10
  }
}
"""),
        (".ai-code-control/config/memory-control.json", MemoryControlJson),
        (".ai-code-control/reports/refactor/current-plan.json",
"""
{
  "task": "none",
  "language": "python",
  "affectedSymbol": "",
  "allowedFiles": [],
  "forbiddenPaths": [".venv/", "__pycache__/", "generated/", "migrations/"],
  "allowedUntrackedPatterns": [".ai-code-control/memory/"],
  "requiredValidation": ["run-validation"],
  "riskLevel": "low"
}
"""),
        (".mcp.json", McpJson),
        (".claude/settings.json", ClaudeSettingsJson),
        (".codex/config.toml", CodexConfigToml),
        ("AGENTS.md", AgentGuide),
        ("CLAUDE.md", ClaudeBootstrap)
    };

    private static List<(string Path, string Content)> Generic() => new()
    {
        (".ai-code-control/config/code-control.json",
"""
{
  "toolchains": [
    {
      "name": "example",
      "enabled": false,
      "path": ".",
      "commands": [
        { "name": "build", "run": "echo replace-with-your-build-command", "timeoutSeconds": 300 }
      ]
    }
  ],
  "git": {
    "protectedBranches": ["main", "master"],
    "forbiddenPaths": ["node_modules/", "dist/", "bin/", "obj/", "generated/"]
  },
  "indexing": {
    "database": ".ai-code-control/db/codegraph.sqlite",
    "exclude": ["**/node_modules/**", "**/dist/**", "**/.git/**"]
  },
  "logging": {
    "level": "info",
    "file": ".ai-code-control/reports/tool.log",
    "maxFileSizeMb": 10
  }
}
"""),
        (".ai-code-control/config/memory-control.json", MemoryControlJson),
        (".ai-code-control/reports/refactor/current-plan.json",
"""
{
  "task": "none",
  "language": "",
  "affectedSymbol": "",
  "allowedFiles": [],
  "forbiddenPaths": [".ai-code-control/db/"],
  "allowedUntrackedPatterns": [".ai-code-control/memory/"],
  "requiredValidation": ["run-validation"],
  "riskLevel": "low"
}
"""),
        (".mcp.json", McpJson),
        (".claude/settings.json", ClaudeSettingsJson),
        (".codex/config.toml", CodexConfigToml),
        ("AGENTS.md", AgentGuide),
        ("CLAUDE.md", ClaudeBootstrap)
    };

    private const string MemoryControlJson =
"""
{
  "memory": {
    "enabled": true,
    "store": ".ai-code-control/db/memory.sqlite",
    "root": ".ai-code-control/memory",
    "include": [
      ".ai-code-control/memory/**/*.md",
      "AGENTS.md",
      "CLAUDE.md",
      "REFACTOR_POLICY.md",
      ".ai-code-control/reports/refactor/**/*.json",
      ".ai-code-control/reports/validation/**/*.md"
    ],
    "exclude": [
      "**/secrets/**",
      "**/.env",
      "**/.env.*",
      "**/*.pem",
      "**/*.pfx",
      "**/*password*",
      "**/*secret*",
      "**/*token*",
      "**/appsettings.Production.json"
    ],
    "maxRecallItems": 8,
    "maxBriefingTokens": 3000,
    "briefCommands": null,
    "rawConversationStorage": {
      "enabled": false,
      "reason": "Raw conversations are noisy and may contain sensitive data. Store summaries instead. (A redacted, searchable conversation archive is planned as a separate store.)"
    }
  }
}
""";

    private const string McpJson =
"""
{
  "mcpServers": {
    "ai-code-control": {
      "command": "node",
      "args": ["tools/ai-code-control/mcp-server/dist/server.js"],
      "env": { "REPO_ROOT": "." }
    }
  }
}
""";

    // SessionStart injects a recent-memory brief into every new Claude Code
    // session; the agent starts with project state instead of re-researching.
    private const string ClaudeSettingsJson =
"""
{
  "hooks": {
    "SessionStart": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "dotnet run --project tools/ai-code-control/src/AiCodeControl.Cli -- memory-brief"
          }
        ]
      }
    ],
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "dotnet run --project tools/ai-code-control/src/AiCodeControl.Cli -- refresh"
          }
        ]
      }
    ]
  }
}
""";

    private const string CodexConfigToml =
"""
[mcp_servers.ai-code-control]
command = "node"
args = ["tools/ai-code-control/mcp-server/dist/server.js"]
cwd = "."
startup_timeout_sec = 30
tool_timeout_sec = 600
required = false

[mcp_servers.ai-code-control.env]
REPO_ROOT = "."
ACC_TOOL_ROOT = "."
""";

    private const string AgentGuide =
"""
# Agent guide

Versioned Markdown, ADRs, contracts and migrations are canonical. SQLite databases are rebuildable caches.

Before editing, run `memory-health`, generate a task-specific `memory-brief`, activate a scoped task manifest, and use `find-symbol` plus `impact-analysis` for existing code.

After editing, run validation, verify changed files, refresh memory/code indexes and write a reviewed task summary. Never persist secrets, personal data or raw conversations.
""";

    private const string ClaudeBootstrap =
"""
# Claude Code bootstrap

Read and follow `AGENTS.md`. Use the ai-code-control MCP server for memory, indexing, impact analysis, validation and task-scope checks.
""";
}
