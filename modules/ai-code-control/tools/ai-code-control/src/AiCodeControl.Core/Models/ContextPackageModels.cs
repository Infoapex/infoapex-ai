using System.Text.Json.Serialization;

namespace AiCodeControl.Core.Models;

public sealed record ContextPackage(
    string SchemaVersion,
    string PackageId,
    string RunId,
    string TaskId,
    string ManifestSha256,
    string CompilerVersion,
    IReadOnlyList<ContextPackageSource> Sources,
    ContextPackageBudget Budget,
    IReadOnlyList<ContextPackageDiagnostic> Diagnostics,
    string ContextDigest,
    DateTimeOffset CreatedAt);

public sealed record ContextPackageSource(
    string SourceId,
    string SourceType,
    string CanonicalRef,
    string SourceHash,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.Never)]
    string? SourceCommit,
    string Authority,
    string SelectionReason,
    ContextPackageContentRange? ContentRange = null,
    string? RenderedContent = null);

public sealed record ContextPackageContentRange(int StartLine, int EndLine);

public sealed record ContextPackageBudget(
    string Measurement,
    int MaximumTokens,
    int EstimatedTokens,
    IReadOnlyList<ContextPackageOmission> OmittedSources,
    int? MaximumCharacters = null,
    int? EstimatedCharacters = null);

public sealed record ContextPackageOmission(
    string SourceId,
    string Reason,
    int EstimatedTokens);

public sealed record ContextPackageDiagnostic(
    string Code,
    string Severity,
    string Message,
    string? SourceId = null);
