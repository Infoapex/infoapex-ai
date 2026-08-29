namespace AiCodeControl.Core.Models;

public sealed record ContextPackageCompilationOptions(
    string RepositoryRoot,
    string ManifestPath,
    string ManifestSha256,
    string TaskId,
    int MaximumTokens = 12_000,
    string? CodegraphDatabasePath = null,
    DateTimeOffset? CreatedAt = null);
