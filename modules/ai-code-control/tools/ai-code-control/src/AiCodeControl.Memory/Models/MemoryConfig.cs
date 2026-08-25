namespace AiCodeControl.Memory.Models;

public sealed class MemoryControlConfig
{
    public MemoryConfig? Memory { get; set; }
}

public sealed class MemoryConfig
{
    public bool Enabled { get; set; } = true;
    public string? Store { get; set; }
    public string? Root { get; set; }
    public List<string> Include { get; set; } = new();
    public List<string> Exclude { get; set; } = new();
    public int MaxRecallItems { get; set; } = 8;
    public int MaxBriefingTokens { get; set; } = 3000;
    public List<string> CanonicalSources { get; set; } = new();

    // Shown at the end of memory-brief; override per project with the exact
    // commands (or MCP tools) the agent should run next.
    public List<string>? BriefCommands { get; set; }
}
