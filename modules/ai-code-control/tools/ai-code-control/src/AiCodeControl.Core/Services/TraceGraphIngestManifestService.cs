using System.Text.Json;
using AiCodeControl.Core.Models;

namespace AiCodeControl.Core.Services;

public sealed class TraceGraphIngestManifestService
{
    private const long MaximumBytes = 2 * 1024 * 1024;
    private static readonly HashSet<string> Kinds = new(StringComparer.Ordinal)
    { "adr", "contract", "plan", "source-map", "context-package", "relations" };
    private static readonly HashSet<string> RootProperties = new(StringComparer.Ordinal)
    { "schemaVersion", "includeCodeIndex", "documents" };
    private static readonly HashSet<string> DocumentProperties = new(StringComparer.Ordinal)
    { "kind", "path", "canonicalRef" };

    public TraceGraphIngestManifest Load(string repositoryRoot, string manifestPath)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(repositoryRoot);
        ArgumentException.ThrowIfNullOrWhiteSpace(manifestPath);
        var root = Path.GetFullPath(repositoryRoot);
        var path = ResolveInside(root, manifestPath, "Trace ingest manifest");
        var info = new FileInfo(path);
        if (!info.Exists) throw new FileNotFoundException("Trace ingest manifest does not exist.", path);
        if (info.Length > MaximumBytes) throw new IOException($"Trace ingest manifest exceeds {MaximumBytes} bytes.");
        using var json = JsonDocument.Parse(File.ReadAllText(path));
        if (json.RootElement.ValueKind != JsonValueKind.Object)
            throw new JsonException("Trace ingest manifest root must be an object.");
        RejectUnknown(json.RootElement, RootProperties, "manifest");
        if (RequiredString(json.RootElement, "schemaVersion") != "1.0")
            throw new JsonException("Trace ingest manifest schemaVersion must be 1.0.");
        var includeCodeIndex = !json.RootElement.TryGetProperty("includeCodeIndex", out var include) ||
                               include.ValueKind == JsonValueKind.True;
        if (json.RootElement.TryGetProperty("includeCodeIndex", out include) &&
            include.ValueKind is not (JsonValueKind.True or JsonValueKind.False))
            throw new JsonException("includeCodeIndex must be a boolean.");
        if (!json.RootElement.TryGetProperty("documents", out var documents) || documents.ValueKind != JsonValueKind.Array)
            throw new JsonException("Trace ingest manifest documents must be an array.");
        if (documents.GetArrayLength() is < 1 or > 10_000)
            throw new JsonException("Trace ingest manifest requires 1..10000 documents.");

        var result = new List<TraceGraphIngestManifestDocument>();
        var identities = new HashSet<string>(StringComparer.Ordinal);
        foreach (var document in documents.EnumerateArray())
        {
            if (document.ValueKind != JsonValueKind.Object) throw new JsonException("Each ingest document must be an object.");
            RejectUnknown(document, DocumentProperties, "document");
            var kind = RequiredString(document, "kind");
            if (!Kinds.Contains(kind)) throw new JsonException($"Unsupported trace ingest document kind: {kind}.");
            var declaredPath = RequiredString(document, "path");
            _ = ResolveInside(root, declaredPath, "Trace ingest document");
            var canonicalRef = RequiredString(document, "canonicalRef").Replace('\\', '/');
            if (Path.IsPathRooted(canonicalRef) || canonicalRef.Split('/', StringSplitOptions.RemoveEmptyEntries).Any(segment => segment == ".."))
                throw new JsonException("canonicalRef must be repository-relative and cannot traverse.");
            if (!identities.Add($"{kind}\n{canonicalRef}"))
                throw new JsonException($"Duplicate trace ingest document identity: {kind}:{canonicalRef}.");
            result.Add(new TraceGraphIngestManifestDocument(kind, declaredPath.Replace('\\', '/'), canonicalRef));
        }
        return new TraceGraphIngestManifest("1.0", includeCodeIndex, result);
    }

    public TraceGraphIngestRequest CreateRequest(string repositoryRoot, string databasePath,
        string manifestPath, string sourceCommit, DateTimeOffset effectiveAt, bool? includeCodeIndex = null)
    {
        var root = Path.GetFullPath(repositoryRoot);
        var manifest = Load(root, manifestPath);
        var documents = manifest.Documents.Select(document => new TraceIngestDocument(
            document.Kind,
            ResolveInside(root, document.Path, "Trace ingest document"),
            document.CanonicalRef)).ToList();
        return new TraceGraphIngestRequest(root, databasePath, sourceCommit, effectiveAt,
            documents, includeCodeIndex ?? manifest.IncludeCodeIndex);
    }

    private static void RejectUnknown(JsonElement element, IReadOnlySet<string> allowed, string label)
    {
        var unknown = element.EnumerateObject().Select(property => property.Name)
            .Where(name => !allowed.Contains(name)).OrderBy(name => name, StringComparer.Ordinal).ToList();
        if (unknown.Count > 0) throw new JsonException($"Unknown {label} properties: {string.Join(", ", unknown)}.");
    }

    private static string RequiredString(JsonElement element, string property)
        => element.TryGetProperty(property, out var value) && value.ValueKind == JsonValueKind.String &&
           !string.IsNullOrWhiteSpace(value.GetString())
            ? value.GetString()!
            : throw new JsonException($"Required string property is missing: {property}.");

    private static string ResolveInside(string root, string value, string label)
    {
        var path = Path.GetFullPath(Path.IsPathRooted(value) ? value : Path.Combine(root, value));
        var prefix = root.TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar) + Path.DirectorySeparatorChar;
        if (!path.StartsWith(prefix, StringComparison.OrdinalIgnoreCase) &&
            !string.Equals(path, root, StringComparison.OrdinalIgnoreCase))
            throw new InvalidOperationException($"{label} must remain inside the repository root.");
        return path;
    }
}
