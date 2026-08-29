using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;
using AiCodeControl.Core.Models;

namespace AiCodeControl.Core.Services;

public sealed partial class ContextPackageCompiler
{
    public const string CompilerVersion = "1.0.0";
    private const int CharactersPerEstimatedToken = 4;
    private const int MaximumMatchesPerSymbol = 5;
    private const long MaximumSourceBytes = 2 * 1024 * 1024;

    public ContextPackage Compile(ContextPackageCompilationOptions options)
    {
        ArgumentNullException.ThrowIfNull(options);
        var repositoryRoot = Path.GetFullPath(options.RepositoryRoot);
        var manifestPath = Path.GetFullPath(options.ManifestPath);
        if (!Directory.Exists(repositoryRoot))
        {
            throw new DirectoryNotFoundException($"Repository root does not exist: {repositoryRoot}");
        }
        if (!File.Exists(manifestPath))
        {
            throw new FileNotFoundException("Worker manifest does not exist", manifestPath);
        }
        if (!Sha256Regex().IsMatch(options.ManifestSha256))
        {
            throw new ArgumentException("ManifestSha256 must be a lowercase SHA-256 value", nameof(options));
        }
        if (options.MaximumTokens < 1 || options.MaximumTokens > int.MaxValue / CharactersPerEstimatedToken)
        {
            throw new ArgumentOutOfRangeException(nameof(options), "MaximumTokens is outside the supported range");
        }

        using var manifest = JsonDocument.Parse(File.ReadAllText(manifestPath));
        var root = manifest.RootElement;
        var runId = RequiredString(root, "runId");
        var task = FindTask(root, options.TaskId);
        var sourceCommit = ReadSourceCommit(root);
        var diagnostics = new List<ContextPackageDiagnostic>();
        var omissions = new List<ContextPackageOmission>();
        var candidates = DiscoverCandidates(
            repositoryRoot,
            task,
            sourceCommit,
            options.CodegraphDatabasePath,
            diagnostics,
            omissions);

        var maximumCharacters = options.MaximumTokens * CharactersPerEstimatedToken;
        var selected = new List<ContextPackageSource>();
        var selectedCharacters = 0;

        foreach (var candidate in candidates
                     .OrderBy(candidate => candidate.Priority)
                     .ThenBy(candidate => candidate.CanonicalRef, StringComparer.Ordinal)
                     .ThenBy(candidate => candidate.ContentRange?.StartLine ?? 0)
                     .ThenBy(candidate => candidate.SourceId, StringComparer.Ordinal))
        {
            var candidateCharacters = candidate.RenderedContent.Length;
            var candidateTokens = EstimateTokens(candidate.RenderedContent);
            if (selectedCharacters + candidateCharacters > maximumCharacters)
            {
                omissions.Add(new ContextPackageOmission(candidate.SourceId, "budget", candidateTokens));
                diagnostics.Add(new ContextPackageDiagnostic(
                    "CTX_BUDGET_OMISSION",
                    "warning",
                    $"Source {candidate.CanonicalRef} was omitted as a whole because it exceeded the remaining budget",
                    candidate.SourceId));
                continue;
            }

            selected.Add(candidate.ToContractSource());
            selectedCharacters += candidateCharacters;
        }

        diagnostics.Add(new ContextPackageDiagnostic(
            "CTX_CHARACTER_FALLBACK",
            "warning",
            "No model tokenizer was configured; deterministic character budgeting was converted to token estimates"));

        var packageIdSeed = $"{runId}\n{options.TaskId}\n{options.ManifestSha256}";
        var packageId = $"ctx-{ShortHash(packageIdSeed, 24)}";
        var package = new ContextPackage(
            SchemaVersion: "1.0",
            PackageId: packageId,
            RunId: runId,
            TaskId: options.TaskId,
            ManifestSha256: options.ManifestSha256,
            CompilerVersion: CompilerVersion,
            Sources: selected,
            Budget: new ContextPackageBudget(
                Measurement: "characters-fallback",
                MaximumTokens: options.MaximumTokens,
                EstimatedTokens: EstimateTokens(selectedCharacters),
                OmittedSources: omissions,
                MaximumCharacters: maximumCharacters,
                EstimatedCharacters: selectedCharacters),
            Diagnostics: diagnostics,
            ContextDigest: new string('0', 64),
            CreatedAt: options.CreatedAt ?? DateTimeOffset.UtcNow);

        return ContextPackageDigest.Apply(package);
    }

    private static IReadOnlyList<SourceCandidate> DiscoverCandidates(
        string repositoryRoot,
        JsonElement task,
        string? sourceCommit,
        string? codegraphDatabasePath,
        List<ContextPackageDiagnostic> diagnostics,
        List<ContextPackageOmission> omissions)
    {
        var candidates = new List<SourceCandidate>();
        var fullFiles = new HashSet<string>(StringComparer.Ordinal);

        foreach (var requiredInput in ReadStringArray(task, "requiredInputs").Distinct(StringComparer.Ordinal).Order(StringComparer.Ordinal))
        {
            AddFileCandidate(
                repositoryRoot,
                requiredInput,
                sourceCommit,
                priority: 0,
                selectionReason: "Declared by task.requiredInputs",
                contentRange: null,
                candidates,
                fullFiles,
                diagnostics,
                omissions);
        }

        foreach (var evidenceContract in ReadEvidenceContracts(task).Distinct(StringComparer.Ordinal).Order(StringComparer.Ordinal))
        {
            if (fullFiles.Contains(NormalizeReference(evidenceContract)))
            {
                continue;
            }

            AddFileCandidate(
                repositoryRoot,
                evidenceContract,
                sourceCommit,
                priority: 1,
                selectionReason: "Declared by task.traceability.gates.evidenceContract",
                contentRange: null,
                candidates,
                fullFiles,
                diagnostics,
                omissions,
                unresolvedCode: "CTX_CONTRACT_UNRESOLVED",
                unresolvedSeverity: "warning");
        }

        var relevantSymbols = ReadStringArray(task, "relevantSymbols")
            .Distinct(StringComparer.Ordinal)
            .Order(StringComparer.Ordinal)
            .ToArray();
        if (relevantSymbols.Length == 0)
        {
            return candidates;
        }

        if (string.IsNullOrWhiteSpace(codegraphDatabasePath) || !File.Exists(codegraphDatabasePath))
        {
            foreach (var symbol in relevantSymbols)
            {
                AddUnavailableSymbol(symbol, "Code graph database is unavailable", diagnostics, omissions);
            }
            return candidates;
        }

        var query = new SymbolQueryService();
        foreach (var symbol in relevantSymbols)
        {
            IReadOnlyList<SymbolQueryMatch> matches;
            try
            {
                matches = query.FindSymbolMatches(codegraphDatabasePath, symbol, MaximumMatchesPerSymbol + 1);
            }
            catch (Exception ex) when (ex is InvalidOperationException or Microsoft.Data.Sqlite.SqliteException)
            {
                AddUnavailableSymbol(symbol, "Code graph query failed", diagnostics, omissions);
                continue;
            }

            if (matches.Count == 0)
            {
                AddUnavailableSymbol(symbol, "No indexed symbol matched the declared relevant symbol", diagnostics, omissions);
                continue;
            }

            foreach (var match in matches.Take(MaximumMatchesPerSymbol))
            {
                var canonicalRef = NormalizeReference(match.File);
                if (fullFiles.Contains(canonicalRef))
                {
                    continue;
                }

                AddFileCandidate(
                    repositoryRoot,
                    canonicalRef,
                    sourceCommit,
                    priority: 2,
                    selectionReason: $"Resolved from task.relevantSymbols: {symbol} -> {match.FullName}",
                    contentRange: new ContextPackageContentRange(match.StartLine, Math.Max(match.StartLine, match.EndLine)),
                    candidates,
                    fullFiles,
                    diagnostics,
                    omissions);
            }

            if (matches.Count > MaximumMatchesPerSymbol)
            {
                var sourceId = $"symbol-{ShortHash(symbol, 16)}";
                omissions.Add(new ContextPackageOmission(sourceId, "policy", 0));
                diagnostics.Add(new ContextPackageDiagnostic(
                    "CTX_SYMBOL_MATCH_CAP",
                    "warning",
                    $"Relevant symbol {symbol} had more than {MaximumMatchesPerSymbol} matches; remaining matches were omitted",
                    sourceId));
            }
        }

        return DeduplicateCandidates(candidates);
    }

    private static void AddFileCandidate(
        string repositoryRoot,
        string reference,
        string? sourceCommit,
        int priority,
        string selectionReason,
        ContextPackageContentRange? contentRange,
        List<SourceCandidate> candidates,
        HashSet<string> fullFiles,
        List<ContextPackageDiagnostic> diagnostics,
        List<ContextPackageOmission> omissions,
        string unresolvedCode = "CTX_INPUT_UNAVAILABLE",
        string unresolvedSeverity = "error")
    {
        var canonicalRef = NormalizeReference(reference);
        var sourceId = $"src-{ShortHash($"{canonicalRef}:{contentRange?.StartLine}:{contentRange?.EndLine}", 20)}";
        if (!IsSafeRepositoryReference(canonicalRef))
        {
            omissions.Add(new ContextPackageOmission(sourceId, "invalid", 0));
            diagnostics.Add(new ContextPackageDiagnostic(
                "CTX_REFERENCE_INVALID",
                "error",
                $"Declared source reference is not a safe repository-relative file: {reference}",
                sourceId));
            return;
        }

        var path = Path.GetFullPath(Path.Combine(repositoryRoot, canonicalRef.Replace('/', Path.DirectorySeparatorChar)));
        if (!path.StartsWith(repositoryRoot + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase) ||
            !File.Exists(path))
        {
            omissions.Add(new ContextPackageOmission(sourceId, "unavailable", 0));
            diagnostics.Add(new ContextPackageDiagnostic(
                unresolvedCode,
                unresolvedSeverity,
                $"Declared source file is unavailable: {canonicalRef}",
                sourceId));
            return;
        }

        if (ContainsReparsePoint(repositoryRoot, path))
        {
            omissions.Add(new ContextPackageOmission(sourceId, "policy", 0));
            diagnostics.Add(new ContextPackageDiagnostic(
                "CTX_SYMLINK_REJECTED",
                unresolvedSeverity,
                $"Declared source traverses a symbolic link or reparse point: {canonicalRef}",
                sourceId));
            return;
        }

        if (new FileInfo(path).Length > MaximumSourceBytes)
        {
            omissions.Add(new ContextPackageOmission(sourceId, "policy", 0));
            diagnostics.Add(new ContextPackageDiagnostic(
                "CTX_SOURCE_TOO_LARGE",
                unresolvedSeverity,
                $"Declared source exceeds the {MaximumSourceBytes}-byte compiler safety limit: {canonicalRef}",
                sourceId));
            return;
        }

        var rawBytes = File.ReadAllBytes(path);
        var normalized = NormalizeText(Encoding.UTF8.GetString(rawBytes));
        var rendered = contentRange is null ? normalized : SelectRange(normalized, contentRange);
        var redaction = Redact(rendered);
        if (redaction.Redacted)
        {
            diagnostics.Add(new ContextPackageDiagnostic(
                "CTX_CONTENT_REDACTED",
                "warning",
                $"Secret-looking content was redacted from {canonicalRef} before package materialization",
                sourceId));
        }

        candidates.Add(new SourceCandidate(
            sourceId,
            contentRange is null ? InferSourceType(canonicalRef) : "symbol",
            canonicalRef,
            Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(normalized))).ToLowerInvariant(),
            sourceCommit,
            "canonical",
            selectionReason,
            contentRange,
            redaction.Text,
            priority));

        if (contentRange is null)
        {
            fullFiles.Add(canonicalRef);
        }
    }

    private static IReadOnlyList<SourceCandidate> DeduplicateCandidates(IEnumerable<SourceCandidate> candidates)
    {
        return candidates
            .GroupBy(
                candidate => $"{candidate.CanonicalRef}:{candidate.ContentRange?.StartLine}:{candidate.ContentRange?.EndLine}",
                StringComparer.Ordinal)
            .Select(group => group
                .OrderBy(candidate => candidate.Priority)
                .ThenBy(candidate => candidate.SourceId, StringComparer.Ordinal)
                .First())
            .ToArray();
    }

    private static void AddUnavailableSymbol(
        string symbol,
        string message,
        List<ContextPackageDiagnostic> diagnostics,
        List<ContextPackageOmission> omissions)
    {
        var sourceId = $"symbol-{ShortHash(symbol, 16)}";
        omissions.Add(new ContextPackageOmission(sourceId, "unavailable", 0));
        diagnostics.Add(new ContextPackageDiagnostic(
            "CTX_SYMBOL_UNAVAILABLE",
            "warning",
            $"{message}: {symbol}",
            sourceId));
    }

    private static JsonElement FindTask(JsonElement root, string taskId)
    {
        if (!root.TryGetProperty("tasks", out var tasks) || tasks.ValueKind != JsonValueKind.Array)
        {
            throw new JsonException("Worker manifest must contain a tasks array");
        }

        foreach (var task in tasks.EnumerateArray())
        {
            if (task.TryGetProperty("id", out var id) && id.GetString() == taskId)
            {
                return task;
            }
        }

        throw new ArgumentException($"Task {taskId} does not exist in the worker manifest", nameof(taskId));
    }

    private static string RequiredString(JsonElement element, string property)
    {
        if (!element.TryGetProperty(property, out var value) ||
            value.ValueKind != JsonValueKind.String ||
            string.IsNullOrWhiteSpace(value.GetString()))
        {
            throw new JsonException($"Worker manifest property {property} is required");
        }

        return value.GetString()!;
    }

    private static string? ReadSourceCommit(JsonElement root)
    {
        if (root.TryGetProperty("base", out var baseElement) &&
            baseElement.TryGetProperty("commit", out var commit) &&
            commit.ValueKind == JsonValueKind.String &&
            commit.GetString() is { } value &&
            GitCommitRegex().IsMatch(value))
        {
            return value;
        }

        return null;
    }

    private static IEnumerable<string> ReadStringArray(JsonElement element, string property)
    {
        if (!element.TryGetProperty(property, out var values) || values.ValueKind != JsonValueKind.Array)
        {
            return [];
        }

        return values.EnumerateArray()
            .Where(value => value.ValueKind == JsonValueKind.String)
            .Select(value => value.GetString())
            .Where(value => !string.IsNullOrWhiteSpace(value))
            .Select(value => value!);
    }

    private static IEnumerable<string> ReadEvidenceContracts(JsonElement task)
    {
        if (!task.TryGetProperty("traceability", out var traceability) ||
            !traceability.TryGetProperty("gates", out var gates) ||
            gates.ValueKind != JsonValueKind.Array)
        {
            return [];
        }

        return gates.EnumerateArray()
            .Where(gate => gate.TryGetProperty("evidenceContract", out _))
            .Select(gate => gate.GetProperty("evidenceContract"))
            .Where(value => value.ValueKind == JsonValueKind.String)
            .Select(value => value.GetString())
            .Where(value => !string.IsNullOrWhiteSpace(value))
            .Select(value => value!);
    }

    private static string SelectRange(string content, ContextPackageContentRange range)
    {
        var lines = content.Split('\n');
        if (range.StartLine > lines.Length)
        {
            return string.Empty;
        }

        var start = range.StartLine - 1;
        var count = Math.Min(range.EndLine, lines.Length) - start;
        return string.Join('\n', lines.Skip(start).Take(count));
    }

    private static string NormalizeText(string value) =>
        value.TrimStart('\uFEFF').Replace("\r\n", "\n", StringComparison.Ordinal).Replace('\r', '\n');

    private static string NormalizeReference(string value) =>
        value.Trim().Replace('\\', '/');

    private static bool IsSafeRepositoryReference(string value)
    {
        if (string.IsNullOrWhiteSpace(value) ||
            value.StartsWith('/') ||
            value.Contains('*') ||
            value.Contains('?') ||
            value.StartsWith("file:", StringComparison.OrdinalIgnoreCase) ||
            WindowsAbsolutePathRegex().IsMatch(value))
        {
            return false;
        }

        return !value.Split('/').Any(segment => segment is ".." or ".");
    }

    private static bool ContainsReparsePoint(string repositoryRoot, string path)
    {
        var relative = Path.GetRelativePath(repositoryRoot, path);
        var current = repositoryRoot;
        foreach (var segment in relative.Split(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar))
        {
            current = Path.Combine(current, segment);
            FileSystemInfo info = Directory.Exists(current)
                ? new DirectoryInfo(current)
                : new FileInfo(current);
            if (info.LinkTarget is not null)
            {
                return true;
            }
        }

        return false;
    }

    private static string InferSourceType(string canonicalRef)
    {
        if (canonicalRef.Contains("/contracts/", StringComparison.OrdinalIgnoreCase) ||
            canonicalRef.StartsWith("contracts/", StringComparison.OrdinalIgnoreCase) ||
            canonicalRef.EndsWith(".schema.json", StringComparison.OrdinalIgnoreCase))
        {
            return "contract";
        }
        if (canonicalRef.Contains("/adr/", StringComparison.OrdinalIgnoreCase) ||
            canonicalRef.Contains("/decisions/", StringComparison.OrdinalIgnoreCase))
        {
            return "decision";
        }
        if (canonicalRef.Contains(".ai-code-control/memory/", StringComparison.OrdinalIgnoreCase))
        {
            return "memory";
        }

        return "file";
    }

    private static int EstimateTokens(string value) => EstimateTokens(value.Length);

    private static int EstimateTokens(int characterCount) =>
        characterCount == 0 ? 0 : (int)Math.Ceiling(characterCount / (double)CharactersPerEstimatedToken);

    private static (string Text, bool Redacted) Redact(string content)
    {
        var redacted = false;
        var text = SecretAssignmentRegex().Replace(content, _ =>
        {
            redacted = true;
            return "[REDACTED]";
        });
        text = OpenAiKeyRegex().Replace(text, _ =>
        {
            redacted = true;
            return "[REDACTED]";
        });
        return (text, redacted);
    }

    private static string ShortHash(string value, int length) =>
        Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(value)))
            .ToLowerInvariant()[..length];

    private sealed record SourceCandidate(
        string SourceId,
        string SourceType,
        string CanonicalRef,
        string SourceHash,
        string? SourceCommit,
        string Authority,
        string SelectionReason,
        ContextPackageContentRange? ContentRange,
        string RenderedContent,
        int Priority)
    {
        public ContextPackageSource ToContractSource() => new(
            SourceId,
            SourceType,
            CanonicalRef,
            SourceHash,
            SourceCommit,
            Authority,
            SelectionReason,
            ContentRange,
            RenderedContent);
    }

    [GeneratedRegex("^[0-9a-f]{64}$", RegexOptions.CultureInvariant)]
    private static partial Regex Sha256Regex();

    [GeneratedRegex("^[0-9a-f]{7,64}$", RegexOptions.CultureInvariant)]
    private static partial Regex GitCommitRegex();

    [GeneratedRegex("^[A-Za-z]:/", RegexOptions.CultureInvariant)]
    private static partial Regex WindowsAbsolutePathRegex();

    [GeneratedRegex("[\"']?(?:api[_-]?key|token|secret|password)[\"']?\\s*[:=]\\s*[\"']?[\\w.-]{8,}[\"']?", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant)]
    private static partial Regex SecretAssignmentRegex();

    [GeneratedRegex("sk-[A-Za-z0-9_-]{12,}", RegexOptions.CultureInvariant)]
    private static partial Regex OpenAiKeyRegex();
}
