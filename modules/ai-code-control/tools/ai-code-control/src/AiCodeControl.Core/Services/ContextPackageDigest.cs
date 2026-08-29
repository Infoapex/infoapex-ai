using System.Security.Cryptography;
using System.Text;
using System.Text.Encodings.Web;
using System.Text.Json;
using System.Text.RegularExpressions;
using AiCodeControl.Core.Models;

namespace AiCodeControl.Core.Services;

public static partial class ContextPackageDigest
{
    private static readonly HashSet<string> SourceTypes = new(StringComparer.Ordinal)
    {
        "file", "symbol", "contract", "decision", "memory", "external", "generated"
    };

    private static readonly HashSet<string> Authorities = new(StringComparer.Ordinal)
    {
        "canonical", "advisory", "proposed", "generated"
    };

    private static readonly HashSet<string> Measurements = new(StringComparer.Ordinal)
    {
        "tokenizer", "characters-fallback"
    };

    private static readonly HashSet<string> OmissionReasons = new(StringComparer.Ordinal)
    {
        "budget", "policy", "unavailable", "invalid"
    };

    private static readonly HashSet<string> DiagnosticSeverities = new(StringComparer.Ordinal)
    {
        "info", "warning", "error"
    };

    public static ContextPackage Apply(ContextPackage package)
    {
        return package with { ContextDigest = Compute(package) };
    }

    public static string Compute(ContextPackage package)
    {
        ArgumentNullException.ThrowIfNull(package);
        var errors = ValidateStructure(package);
        if (errors.Count > 0)
        {
            throw new ArgumentException(
                $"Invalid context package: {string.Join("; ", errors)}",
                nameof(package));
        }

        using var stream = new MemoryStream();
        using (var writer = new Utf8JsonWriter(stream, new JsonWriterOptions
        {
            Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping
        }))
        {
            WriteSemanticPackage(writer, package);
        }

        return Convert.ToHexString(SHA256.HashData(stream.ToArray())).ToLowerInvariant();
    }

    public static IReadOnlyList<string> Validate(ContextPackage package)
    {
        ArgumentNullException.ThrowIfNull(package);
        var errors = ValidateStructure(package);

        if (!IsSha256(package.ContextDigest))
        {
            errors.Add("contextDigest must be a lowercase SHA-256 value");
        }
        else if (errors.Count == 0)
        {
            var expected = Compute(package);
            if (!string.Equals(package.ContextDigest, expected, StringComparison.Ordinal))
            {
                errors.Add("contextDigest does not match the semantic package content");
            }
        }

        return errors;
    }

    private static List<string> ValidateStructure(ContextPackage package)
    {
        var errors = new List<string>();

        if (package.SchemaVersion != "1.0")
        {
            errors.Add("schemaVersion must be 1.0");
        }

        ValidateIdentifier(package.PackageId, "packageId", errors);
        ValidateIdentifier(package.RunId, "runId", errors);
        ValidateIdentifier(package.TaskId, "taskId", errors);

        if (!IsSha256(package.ManifestSha256))
        {
            errors.Add("manifestSha256 must be a lowercase SHA-256 value");
        }

        if (string.IsNullOrWhiteSpace(package.CompilerVersion))
        {
            errors.Add("compilerVersion is required");
        }

        if (package.Sources is null)
        {
            errors.Add("sources is required");
        }
        else
        {
            ValidateSources(package.Sources, errors);
        }

        if (package.Budget is null)
        {
            errors.Add("budget is required");
        }
        else
        {
            ValidateBudget(package.Budget, package.Sources ?? [], errors);
        }

        if (package.Diagnostics is null)
        {
            errors.Add("diagnostics is required");
        }
        else
        {
            ValidateDiagnostics(
                package.Diagnostics,
                package.Sources ?? [],
                package.Budget?.OmittedSources ?? [],
                errors);
        }

        return errors;
    }

    private static void ValidateSources(
        IReadOnlyList<ContextPackageSource> sources,
        List<string> errors)
    {
        var ids = new HashSet<string>(StringComparer.Ordinal);
        foreach (var source in sources)
        {
            ValidateIdentifier(source.SourceId, "sourceId", errors);
            if (!ids.Add(source.SourceId))
            {
                errors.Add($"duplicate sourceId: {source.SourceId}");
            }

            if (!SourceTypes.Contains(source.SourceType))
            {
                errors.Add($"source {source.SourceId} has unsupported sourceType: {source.SourceType}");
            }

            if (!IsCanonicalReference(source.CanonicalRef))
            {
                errors.Add($"source {source.SourceId} canonicalRef must be stable and non-local");
            }

            if (!IsSha256(source.SourceHash))
            {
                errors.Add($"source {source.SourceId} sourceHash must be a lowercase SHA-256 value");
            }

            if (source.SourceCommit is not null && !GitCommitRegex().IsMatch(source.SourceCommit))
            {
                errors.Add($"source {source.SourceId} sourceCommit must be null or a lowercase Git object id");
            }

            if (!Authorities.Contains(source.Authority))
            {
                errors.Add($"source {source.SourceId} has unsupported authority: {source.Authority}");
            }

            if (string.IsNullOrWhiteSpace(source.SelectionReason))
            {
                errors.Add($"source {source.SourceId} selectionReason is required");
            }

            if (source.ContentRange is { } range &&
                (range.StartLine < 1 || range.EndLine < range.StartLine))
            {
                errors.Add($"source {source.SourceId} contentRange must be a valid inclusive line range");
            }
        }
    }

    private static void ValidateBudget(
        ContextPackageBudget budget,
        IReadOnlyList<ContextPackageSource> sources,
        List<string> errors)
    {
        if (!Measurements.Contains(budget.Measurement))
        {
            errors.Add($"unsupported budget measurement: {budget.Measurement}");
        }

        if (budget.MaximumTokens < 1)
        {
            errors.Add("budget.maximumTokens must be positive");
        }

        if (budget.EstimatedTokens < 0 || budget.EstimatedTokens > budget.MaximumTokens)
        {
            errors.Add("budget.estimatedTokens must be between zero and maximumTokens");
        }

        if (budget.Measurement == "characters-fallback")
        {
            if (budget.MaximumCharacters is null || budget.MaximumCharacters < 1 ||
                budget.EstimatedCharacters is null || budget.EstimatedCharacters < 0 ||
                budget.EstimatedCharacters > budget.MaximumCharacters)
            {
                errors.Add("character fallback requires a valid explicit character budget");
            }
        }
        else if (budget.MaximumCharacters is not null || budget.EstimatedCharacters is not null)
        {
            errors.Add("character budget fields are only allowed for characters-fallback measurement");
        }

        if (budget.OmittedSources is null)
        {
            errors.Add("budget.omittedSources is required");
            return;
        }

        var included = sources.Select(source => source.SourceId).ToHashSet(StringComparer.Ordinal);
        var omitted = new HashSet<string>(StringComparer.Ordinal);
        foreach (var omission in budget.OmittedSources)
        {
            ValidateIdentifier(omission.SourceId, "omitted sourceId", errors);
            if (!omitted.Add(omission.SourceId))
            {
                errors.Add($"duplicate omitted sourceId: {omission.SourceId}");
            }

            if (included.Contains(omission.SourceId))
            {
                errors.Add($"source {omission.SourceId} cannot be both included and omitted");
            }

            if (!OmissionReasons.Contains(omission.Reason))
            {
                errors.Add($"source {omission.SourceId} has unsupported omission reason: {omission.Reason}");
            }

            if (omission.EstimatedTokens < 0)
            {
                errors.Add($"source {omission.SourceId} omitted estimatedTokens cannot be negative");
            }
        }
    }

    private static void ValidateDiagnostics(
        IReadOnlyList<ContextPackageDiagnostic> diagnostics,
        IReadOnlyList<ContextPackageSource> sources,
        IReadOnlyList<ContextPackageOmission> omissions,
        List<string> errors)
    {
        var sourceIds = sources.Select(source => source.SourceId).ToHashSet(StringComparer.Ordinal);
        sourceIds.UnionWith(omissions.Select(omission => omission.SourceId));
        foreach (var diagnostic in diagnostics)
        {
            ValidateIdentifier(diagnostic.Code, "diagnostic code", errors);
            if (!DiagnosticSeverities.Contains(diagnostic.Severity))
            {
                errors.Add($"diagnostic {diagnostic.Code} has unsupported severity: {diagnostic.Severity}");
            }

            if (string.IsNullOrWhiteSpace(diagnostic.Message))
            {
                errors.Add($"diagnostic {diagnostic.Code} message is required");
            }

            if (diagnostic.SourceId is not null && !sourceIds.Contains(diagnostic.SourceId))
            {
                errors.Add($"diagnostic {diagnostic.Code} references unknown sourceId: {diagnostic.SourceId}");
            }
        }
    }

    private static bool IsCanonicalReference(string value)
    {
        if (string.IsNullOrWhiteSpace(value) || value.Contains('\\') || value.StartsWith('/'))
        {
            return false;
        }

        if (value.StartsWith("file:", StringComparison.OrdinalIgnoreCase) ||
            WindowsAbsolutePathRegex().IsMatch(value))
        {
            return false;
        }

        return !value.Split('/').Any(segment => segment == "..");
    }

    private static void ValidateIdentifier(string value, string name, List<string> errors)
    {
        if (string.IsNullOrWhiteSpace(value) || !IdentifierRegex().IsMatch(value))
        {
            errors.Add($"{name} is not a valid stable identifier");
        }
    }

    private static bool IsSha256(string value) =>
        value is not null && Sha256Regex().IsMatch(value);

    private static void WriteSemanticPackage(Utf8JsonWriter writer, ContextPackage package)
    {
        writer.WriteStartObject();
        writer.WriteString("schemaVersion", package.SchemaVersion);
        writer.WriteString("runId", package.RunId);
        writer.WriteString("taskId", package.TaskId);
        writer.WriteString("manifestSha256", package.ManifestSha256);
        writer.WriteString("compilerVersion", package.CompilerVersion);

        writer.WritePropertyName("sources");
        writer.WriteStartArray();
        foreach (var source in package.Sources
                     .OrderBy(item => item.SourceId, StringComparer.Ordinal)
                     .ThenBy(item => item.CanonicalRef, StringComparer.Ordinal)
                     .ThenBy(item => item.SourceHash, StringComparer.Ordinal))
        {
            writer.WriteStartObject();
            writer.WriteString("sourceId", source.SourceId);
            writer.WriteString("sourceType", source.SourceType);
            writer.WriteString("canonicalRef", source.CanonicalRef);
            writer.WriteString("sourceHash", source.SourceHash);
            if (source.SourceCommit is null)
            {
                writer.WriteNull("sourceCommit");
            }
            else
            {
                writer.WriteString("sourceCommit", source.SourceCommit);
            }

            writer.WriteString("authority", source.Authority);
            writer.WriteString("selectionReason", source.SelectionReason);
            if (source.ContentRange is { } range)
            {
                writer.WritePropertyName("contentRange");
                writer.WriteStartObject();
                writer.WriteNumber("startLine", range.StartLine);
                writer.WriteNumber("endLine", range.EndLine);
                writer.WriteEndObject();
            }

            if (source.RenderedContent is not null)
            {
                writer.WriteString("renderedContent", source.RenderedContent);
            }

            writer.WriteEndObject();
        }
        writer.WriteEndArray();

        writer.WritePropertyName("budget");
        writer.WriteStartObject();
        writer.WriteString("measurement", package.Budget.Measurement);
        writer.WriteNumber("maximumTokens", package.Budget.MaximumTokens);
        writer.WriteNumber("estimatedTokens", package.Budget.EstimatedTokens);
        if (package.Budget.MaximumCharacters is int maximumCharacters)
        {
            writer.WriteNumber("maximumCharacters", maximumCharacters);
        }
        if (package.Budget.EstimatedCharacters is int estimatedCharacters)
        {
            writer.WriteNumber("estimatedCharacters", estimatedCharacters);
        }
        writer.WritePropertyName("omittedSources");
        writer.WriteStartArray();
        foreach (var omission in package.Budget.OmittedSources
                     .OrderBy(item => item.SourceId, StringComparer.Ordinal)
                     .ThenBy(item => item.Reason, StringComparer.Ordinal))
        {
            writer.WriteStartObject();
            writer.WriteString("sourceId", omission.SourceId);
            writer.WriteString("reason", omission.Reason);
            writer.WriteNumber("estimatedTokens", omission.EstimatedTokens);
            writer.WriteEndObject();
        }
        writer.WriteEndArray();
        writer.WriteEndObject();

        writer.WritePropertyName("diagnostics");
        writer.WriteStartArray();
        foreach (var diagnostic in package.Diagnostics
                     .OrderBy(item => item.Code, StringComparer.Ordinal)
                     .ThenBy(item => item.SourceId, StringComparer.Ordinal)
                     .ThenBy(item => item.Severity, StringComparer.Ordinal)
                     .ThenBy(item => item.Message, StringComparer.Ordinal))
        {
            writer.WriteStartObject();
            writer.WriteString("code", diagnostic.Code);
            writer.WriteString("severity", diagnostic.Severity);
            writer.WriteString("message", diagnostic.Message);
            if (diagnostic.SourceId is not null)
            {
                writer.WriteString("sourceId", diagnostic.SourceId);
            }
            writer.WriteEndObject();
        }
        writer.WriteEndArray();
        writer.WriteEndObject();
    }

    [GeneratedRegex("^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$", RegexOptions.CultureInvariant)]
    private static partial Regex IdentifierRegex();

    [GeneratedRegex("^[0-9a-f]{64}$", RegexOptions.CultureInvariant)]
    private static partial Regex Sha256Regex();

    [GeneratedRegex("^[0-9a-f]{7,64}$", RegexOptions.CultureInvariant)]
    private static partial Regex GitCommitRegex();

    [GeneratedRegex("^[A-Za-z]:/", RegexOptions.CultureInvariant)]
    private static partial Regex WindowsAbsolutePathRegex();
}
