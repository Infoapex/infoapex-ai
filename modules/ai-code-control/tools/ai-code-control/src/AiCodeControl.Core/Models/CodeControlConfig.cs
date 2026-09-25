namespace AiCodeControl.Core.Models;

public sealed class CodeControlConfig
{
    public List<ToolchainConfig>? Toolchains { get; set; }
    public IndexingConfig? Indexing { get; set; }
    public GitConfig? Git { get; set; }
    public LoggingConfig? Logging { get; set; }
}

// Generic, config-driven toolchain: any language stack is a named list of
// commands. Adding a new stack is a config change, not a code change.
public sealed class ToolchainConfig
{
    public string? Name { get; set; }
    public bool Enabled { get; set; } = true;
    public string? Path { get; set; }
    public List<ToolchainCommand>? Commands { get; set; }
}

public sealed class ToolchainCommand
{
    public string? Name { get; set; }
    public string? Run { get; set; }
    public int TimeoutSeconds { get; set; } = 300;
}

public sealed class IndexingConfig
{
    public string? Database { get; set; }
    public List<string>? Exclude { get; set; }
    public Dictionary<string, List<string>>? Languages { get; set; }
}

public sealed class GitConfig
{
    public List<string>? ProtectedBranches { get; set; }
    public List<string>? ForbiddenPaths { get; set; }
}

public sealed class LoggingConfig
{
    public string? Level { get; set; }
    public string? File { get; set; }
    public int? MaxFileSizeMb { get; set; }
}
