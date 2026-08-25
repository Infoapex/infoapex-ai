using System.Text.Json.Serialization;

namespace AiCodeControl.RefactorGuard.Models;

public sealed class RefactorPlan
{
    public string? SchemaVersion { get; set; } = "1.0";
    public string? TaskId { get; set; }
    public string? Task { get; set; }
    public string? Owner { get; set; }
    public string? Branch { get; set; }
    public string? BaseCommit { get; set; }
    public string? Status { get; set; }
    public string? Language { get; set; }
    public string? AffectedSymbol { get; set; }
    public List<string> AllowedFiles { get; set; } = new();
    public List<string> AllowedPatterns { get; set; } = new();
    public List<string> ForbiddenPaths { get; set; } = new();
    public List<string> RequiredValidation { get; set; } = new();
    public string? RiskLevel { get; set; }
    public List<string> AcceptanceCriteria { get; set; } = new();
    public List<string> DependsOn { get; set; } = new();
    // Prefix patterns for intentional untracked files that should not be flagged as unexpected.
    public List<string> AllowedUntrackedPatterns { get; set; } = new();
}

public sealed class VerifyChangedFilesResult
{
    [JsonPropertyName("schemaVersion")]
    public int SchemaVersion { get; set; } = 1;
    [JsonPropertyName("status")]
    public string Status { get; set; } = "fail";
    [JsonPropertyName("branch")]
    public string Branch { get; set; } = "";
    [JsonPropertyName("changedFiles")]
    public List<string> ChangedFiles { get; set; } = new();
    [JsonPropertyName("unexpectedFiles")]
    public List<string> UnexpectedFiles { get; set; } = new();
    [JsonPropertyName("forbiddenFiles")]
    public List<string> ForbiddenFiles { get; set; } = new();
    [JsonPropertyName("conflictingTasks")]
    public List<string> ConflictingTasks { get; set; } = new();
    [JsonPropertyName("allowedUntrackedFiles")]
    public List<string> AllowedUntrackedFiles { get; set; } = new();
    [JsonPropertyName("filteredArtifactsCount")]
    public int FilteredArtifactsCount { get; set; }
    [JsonPropertyName("notes")]
    public List<string> Notes { get; set; } = new();
}
