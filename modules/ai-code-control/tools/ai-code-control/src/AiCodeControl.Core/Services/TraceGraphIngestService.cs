using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;
using AiCodeControl.Core.Models;
using Microsoft.Data.Sqlite;

namespace AiCodeControl.Core.Services;

public sealed partial class TraceGraphIngestService
{
    private static readonly HashSet<string> DocumentKinds = new(StringComparer.Ordinal)
    { "adr", "contract", "plan", "source-map", "context-package", "relations" };

    public TraceGraphIngestResult Build(TraceGraphIngestRequest request)
    {
        ArgumentNullException.ThrowIfNull(request);
        var root = Path.GetFullPath(request.RepositoryRoot);
        if (!Directory.Exists(root)) throw new DirectoryNotFoundException(root);
        if (string.IsNullOrWhiteSpace(request.SourceCommit)) throw new ArgumentException("SourceCommit is required", nameof(request));
        var accumulator = new Accumulator();
        var diagnostics = new List<TraceIngestDiagnostic>();
        var resolver = LoadCodeIndex(request, accumulator, diagnostics);
        var read = 0;
        var skipped = 0;

        foreach (var document in request.Documents.OrderBy(item => item.CanonicalRef, StringComparer.Ordinal))
        {
            if (!DocumentKinds.Contains(document.Kind))
            {
                diagnostics.Add(Diagnostic("DOCUMENT_KIND_UNKNOWN", document.CanonicalRef, $"Unknown ingest document kind: {document.Kind}"));
                skipped++;
                continue;
            }
            if (Path.IsPathRooted(document.CanonicalRef) || WindowsAbsolutePathRegex().IsMatch(document.CanonicalRef))
                throw new ArgumentException($"CanonicalRef must not expose an absolute path: {document.CanonicalRef}", nameof(request));
            if (!File.Exists(document.FilePath))
            {
                diagnostics.Add(Diagnostic("DOCUMENT_MISSING", document.CanonicalRef, "Declared ingest document does not exist"));
                skipped++;
                continue;
            }

            try
            {
                var bytes = File.ReadAllBytes(document.FilePath);
                var content = Encoding.UTF8.GetString(bytes);
                var hash = Hash(bytes);
                switch (document.Kind)
                {
                    case "adr": IngestAdr(document, content, hash, accumulator, diagnostics); break;
                    case "contract": IngestContract(document, content, hash, accumulator, diagnostics); break;
                    case "plan": IngestPlan(document, content, hash, accumulator, diagnostics); break;
                    case "source-map": IngestSourceMap(document, content, hash, resolver, accumulator, diagnostics); break;
                    case "context-package": IngestContextPackage(document, content, hash, resolver, accumulator, diagnostics); break;
                    case "relations": IngestDeclaredRelations(document, content, hash, accumulator); break;
                }
                read++;
            }
            catch (JsonException exception)
            {
                diagnostics.Add(Diagnostic("DOCUMENT_JSON_INVALID", document.CanonicalRef, exception.Message));
                skipped++;
            }
        }

        accumulator.ResolveEdges(diagnostics);
        var snapshot = new TraceGraphSnapshot("repository-trace", request.SourceCommit,
            request.EffectiveAt, accumulator.Nodes, accumulator.Edges);
        return new TraceGraphIngestResult(snapshot, diagnostics.OrderBy(item => item.SourceRef, StringComparer.Ordinal)
            .ThenBy(item => item.Code, StringComparer.Ordinal).ToList(), read, skipped,
            accumulator.Nodes.Count, accumulator.Edges.Count);
    }

    public (TraceGraphIngestResult Ingest, TraceGraphState State) Rebuild(
        TraceGraphIngestRequest request, TraceGraphRepository repository)
    {
        ArgumentNullException.ThrowIfNull(repository);
        var result = Build(request);
        if (result.Diagnostics.Any(item => item.Severity == "error"))
            throw new InvalidOperationException("Trace ingestion produced blocking diagnostics");
        return (result, repository.Rebuild(request.CodegraphDatabasePath, [result.Snapshot]));
    }

    private static SymbolResolver LoadCodeIndex(TraceGraphIngestRequest request, Accumulator accumulator,
        List<TraceIngestDiagnostic> diagnostics)
    {
        var resolver = new SymbolResolver();
        if (!request.IncludeCodeIndex) return resolver;
        if (!File.Exists(request.CodegraphDatabasePath))
        {
            diagnostics.Add(Diagnostic("CODE_INDEX_MISSING", "codegraph.sqlite", "Code index is unavailable"));
            return resolver;
        }

        using var connection = new SqliteConnection($"Data Source={request.CodegraphDatabasePath}");
        connection.Open();
        using (var command = connection.CreateCommand())
        {
            command.CommandText = "SELECT path,hash FROM files ORDER BY path";
            using var reader = command.ExecuteReader();
            while (reader.Read())
            {
                var path = reader.GetString(0).Replace('\\', '/');
                accumulator.AddNode(Node("file", "file", path, path, reader.GetString(1),
                    "ast", "T0", "canonical", new { sourceRef = "codegraph.sqlite" }), "codegraph.sqlite", diagnostics);
            }
        }
        using (var command = connection.CreateCommand())
        {
            command.CommandText = "SELECT s.name,s.full_name,f.hash,f.path FROM symbols s JOIN files f ON f.id=s.file_id ORDER BY s.full_name,f.path";
            using var reader = command.ExecuteReader();
            while (reader.Read())
            {
                var name = reader.GetString(0); var fullName = reader.GetString(1);
                resolver.Add(name, fullName);
                accumulator.AddNode(Node("symbol", "symbol", fullName, fullName, reader.GetString(2),
                    "ast", "T0", "canonical", new { sourceRef = reader.GetString(3).Replace('\\', '/') }), "codegraph.sqlite", diagnostics);
            }
        }
        return resolver;
    }

    private static void IngestAdr(TraceIngestDocument document, string content, string hash,
        Accumulator accumulator, List<TraceIngestDiagnostic> diagnostics)
    {
        var id = Path.GetFileNameWithoutExtension(document.CanonicalRef);
        var title = HeadingRegex().Match(content) is { Success: true } heading ? heading.Groups[1].Value.Trim() : id;
        var statusMatch = StatusRegex().Match(content);
        var status = statusMatch.Success ? statusMatch.Groups[1].Value.ToLowerInvariant() : "unknown";
        var authority = status == "accepted" ? "canonical" : status == "proposed" ? "proposed" : "advisory";
        accumulator.AddNode(Node("adr", "adr", id, title, hash, "adr", "T1", authority,
            new { sourceRef = document.CanonicalRef, status }), document.CanonicalRef, diagnostics);
        if (status == "proposed")
            diagnostics.Add(new TraceIngestDiagnostic("PROPOSED_DECISION", "info", document.CanonicalRef,
                "Decision is indexed with proposed authority and cannot be treated as accepted"));
        foreach (Match match in SupersedesRegex().Matches(content))
            foreach (Match target in AdrIdRegex().Matches(match.Groups[1].Value))
                accumulator.AddPending("supersedes", Id("adr", id), Id("adr", target.Value),
                    "adr", "declared", "T1", document.CanonicalRef, hash, document.CanonicalRef);
    }

    private static void IngestContract(TraceIngestDocument document, string content, string hash,
        Accumulator accumulator, List<TraceIngestDiagnostic> diagnostics)
    {
        using var json = JsonDocument.Parse(content);
        if (json.RootElement.ValueKind != JsonValueKind.Object) throw new JsonException("Contract root must be an object");
        hash = CanonicalJsonHash(json.RootElement);
        var canonical = String(json.RootElement, "$id") ?? document.CanonicalRef;
        var title = String(json.RootElement, "title") ?? canonical;
        var contractId = Id("contract", canonical);
        accumulator.AddNode(Node("contract", "contract", canonical, title, hash, "json-contract", "T0", "canonical",
            new { sourceRef = document.CanonicalRef }), document.CanonicalRef, diagnostics);
        foreach (var criterion in FindStringProperties(json.RootElement, "criterionId").Distinct(StringComparer.Ordinal))
        {
            accumulator.AddNode(Node("criterion", "criterion", criterion, criterion, hash, "json-contract", "T0", "canonical",
                new { sourceRef = document.CanonicalRef }), document.CanonicalRef, diagnostics);
            accumulator.AddPending("references", contractId, Id("criterion", criterion), "json-contract", "deterministic", "T0",
                document.CanonicalRef, hash, document.CanonicalRef);
        }
    }

    private static void IngestPlan(TraceIngestDocument document, string content, string hash,
        Accumulator accumulator, List<TraceIngestDiagnostic> diagnostics)
    {
        using var json = JsonDocument.Parse(content);
        hash = CanonicalJsonHash(json.RootElement);
        if (!json.RootElement.TryGetProperty("tasks", out var tasks) || tasks.ValueKind != JsonValueKind.Array)
            throw new JsonException("Plan tasks must be an array");
        foreach (var task in tasks.EnumerateArray())
        {
            var taskId = RequiredString(task, "id");
            accumulator.AddNode(Node("task", "task", taskId, String(task, "goal") ?? taskId, hash,
                "manifest", "T1", "canonical", new { sourceRef = document.CanonicalRef }), document.CanonicalRef, diagnostics);
        }
        foreach (var task in tasks.EnumerateArray())
        {
            var taskId = RequiredString(task, "id"); var taskNodeId = Id("task", taskId);
            var traceability = task.TryGetProperty("traceability", out var declaredTraceability)
                && declaredTraceability.ValueKind == JsonValueKind.Object
                ? declaredTraceability
                : task;
            if (traceability.TryGetProperty("acceptanceCriteria", out var criteria) && criteria.ValueKind == JsonValueKind.Array)
                foreach (var criterion in criteria.EnumerateArray())
                {
                    var criterionId = RequiredString(criterion, "criterionId");
                    accumulator.AddNode(Node("criterion", "criterion", criterionId, String(criterion, "text") ?? criterionId,
                        hash, "manifest", "T1", "canonical", new { sourceRef = document.CanonicalRef }), document.CanonicalRef, diagnostics);
                    accumulator.AddPending("implements", taskNodeId, Id("criterion", criterionId), "manifest", "declared", "T1",
                        document.CanonicalRef, hash, document.CanonicalRef);
                }
            if (traceability.TryGetProperty("gates", out var gates) && gates.ValueKind == JsonValueKind.Array)
                foreach (var gate in gates.EnumerateArray())
                {
                    var gateId = RequiredString(gate, "gateId");
                    accumulator.AddNode(Node("gate", "gate", gateId, gateId, hash, "manifest", "T1", "canonical",
                        new { sourceRef = document.CanonicalRef }), document.CanonicalRef, diagnostics);
                    if (gate.TryGetProperty("criterionIds", out var ids) && ids.ValueKind == JsonValueKind.Array)
                        foreach (var criterionId in ids.EnumerateArray().Select(item => item.GetString()).Where(item => item is not null))
                            accumulator.AddPending("verified_by", Id("criterion", criterionId!), Id("gate", gateId),
                                "manifest", "declared", "T1", document.CanonicalRef, hash, document.CanonicalRef);
                }
            if (task.TryGetProperty("dependsOn", out var dependencies) && dependencies.ValueKind == JsonValueKind.Array)
                foreach (var dependency in dependencies.EnumerateArray().Select(item => item.GetString()).Where(item => item is not null))
                    accumulator.AddPending("depends_on", taskNodeId, Id("task", dependency!), "manifest", "declared", "T1",
                        document.CanonicalRef, hash, document.CanonicalRef);
            if (task.TryGetProperty("requiredInputs", out var inputs) && inputs.ValueKind == JsonValueKind.Array)
                foreach (var input in inputs.EnumerateArray())
                {
                    var reference = input.ValueKind == JsonValueKind.String ? input.GetString() : String(input, "ref");
                    if (string.IsNullOrWhiteSpace(reference)) continue;
                    var type = InferSourceType(reference!);
                    accumulator.AddNode(Node(type, type, NormalizeRef(type, reference!), reference!, hash, "manifest", "T1",
                        type == "contract" ? "canonical" : "advisory", new { sourceRef = document.CanonicalRef }), document.CanonicalRef, diagnostics);
                    accumulator.AddPending("selected_for", Id(type, NormalizeRef(type, reference!)), taskNodeId,
                        "manifest", "declared", "T1", document.CanonicalRef, hash, document.CanonicalRef);
                }
        }
    }

    private static void IngestSourceMap(TraceIngestDocument document, string content, string hash, SymbolResolver resolver,
        Accumulator accumulator, List<TraceIngestDiagnostic> diagnostics)
    {
        using var json = JsonDocument.Parse(content);
        hash = ValidHash(String(json.RootElement, "sourceMapDigest")) ?? hash;
        if (!json.RootElement.TryGetProperty("nodes", out var nodes) || nodes.ValueKind != JsonValueKind.Array)
            throw new JsonException("Source map nodes must be an array");
        var local = new Dictionary<string, string>(StringComparer.Ordinal);
        foreach (var node in nodes.EnumerateArray())
        {
            var localId = RequiredString(node, "nodeId"); var kind = RequiredString(node, "kind");
            var canonical = RequiredString(node, "canonicalRef"); var authority = String(node, "authority") ?? "advisory";
            var type = MapSourceMapType(kind, canonical);
            canonical = NormalizeRef(type, canonical);
            if (type == "symbol")
            {
                var resolution = resolver.Resolve(canonical);
                if (resolution.Candidates.Count != 1)
                {
                    diagnostics.Add(new TraceIngestDiagnostic(resolution.Candidates.Count == 0 ? "SYMBOL_NOT_FOUND" : "SYMBOL_AMBIGUOUS",
                        "warning", document.CanonicalRef, $"Symbol {canonical} was not resolved uniquely", resolution.Candidates));
                    continue;
                }
                canonical = resolution.Candidates[0];
            }
            var graphId = Id(type, canonical); local[localId] = graphId;
            accumulator.AddNode(Node(type, type, canonical, canonical, hash, "runtime-evidence", "T0", authority,
                new { sourceRef = document.CanonicalRef, sourceMapNodeId = localId }), document.CanonicalRef, diagnostics);
        }
        if (!json.RootElement.TryGetProperty("edges", out var edges) || edges.ValueKind != JsonValueKind.Array) return;
        foreach (var edge in edges.EnumerateArray())
        {
            var fromLocal = RequiredString(edge, "fromNodeId"); var toLocal = RequiredString(edge, "toNodeId");
            if (!local.TryGetValue(fromLocal, out var from) || !local.TryGetValue(toLocal, out var to))
            {
                diagnostics.Add(Diagnostic("EDGE_ENDPOINT_UNRESOLVED", document.CanonicalRef, $"Source-map edge has unresolved endpoint: {fromLocal} -> {toLocal}"));
                continue;
            }
            var relation = RequiredString(edge, "relation"); var confidence = RequiredString(edge, "confidence");
            var mapped = MapRelation(relation, from, to);
            var refs = edge.TryGetProperty("evidenceRefs", out var evidence) && evidence.ValueKind == JsonValueKind.Array
                ? evidence.EnumerateArray().Select(item => item.GetString()).Where(item => item is not null).Select(item => $"{document.CanonicalRef}::{item}").ToList()
                : [document.CanonicalRef];
            var origin = confidence == "declared" ? "manifest" : confidence == "derived" ? "json-contract" : "runtime-evidence";
            var tier = confidence == "declared" ? "T1" : "T0";
            var graphConfidence = confidence == "declared" ? "declared" : "deterministic";
            foreach (var evidenceRef in refs)
                accumulator.AddPending(mapped.Relation, mapped.From, mapped.To, origin, graphConfidence, tier,
                    evidenceRef!, hash, document.CanonicalRef);
        }
    }

    private static void IngestContextPackage(TraceIngestDocument document, string content, string hash, SymbolResolver resolver,
        Accumulator accumulator, List<TraceIngestDiagnostic> diagnostics)
    {
        using var json = JsonDocument.Parse(content);
        hash = ValidHash(String(json.RootElement, "contextDigest")) ?? hash;
        var packageRef = String(json.RootElement, "contextDigest") ?? RequiredString(json.RootElement, "packageId");
        var taskRef = RequiredString(json.RootElement, "taskId");
        accumulator.AddNode(Node("context-package", "context-package", packageRef, packageRef, hash,
            "json-contract", "T0", "generated", new { sourceRef = document.CanonicalRef }), document.CanonicalRef, diagnostics);
        accumulator.AddNode(Node("task", "task", taskRef, taskRef, hash, "json-contract", "T0", "canonical",
            new { sourceRef = document.CanonicalRef }), document.CanonicalRef, diagnostics);
        if (!json.RootElement.TryGetProperty("sources", out var sources) || sources.ValueKind != JsonValueKind.Array) return;
        foreach (var source in sources.EnumerateArray())
        {
            var type = MapContextType(RequiredString(source, "sourceType"));
            var canonical = NormalizeRef(type, RequiredString(source, "canonicalRef"));
            if (type == "symbol")
            {
                var resolution = resolver.Resolve(canonical);
                if (resolution.Candidates.Count != 1)
                {
                    diagnostics.Add(new TraceIngestDiagnostic(resolution.Candidates.Count == 0 ? "SYMBOL_NOT_FOUND" : "SYMBOL_AMBIGUOUS",
                        "warning", document.CanonicalRef, $"Context symbol {canonical} was not resolved uniquely", resolution.Candidates));
                    continue;
                }
                canonical = resolution.Candidates[0];
            }
            var authority = String(source, "authority") ?? "advisory";
            var sourceHash = String(source, "sourceHash") ?? hash;
            accumulator.AddNode(Node(type, type, canonical, canonical, sourceHash, "json-contract", "T0", authority,
                new { sourceRef = document.CanonicalRef }), document.CanonicalRef, diagnostics);
            accumulator.AddPending("derived_from", Id("context-package", packageRef), Id(type, canonical),
                "json-contract", "deterministic", "T0", document.CanonicalRef, hash, document.CanonicalRef);
            accumulator.AddPending("selected_for", Id(type, canonical), Id("task", taskRef),
                "json-contract", "deterministic", "T0", document.CanonicalRef, hash, document.CanonicalRef);
        }
    }

    private static void IngestDeclaredRelations(TraceIngestDocument document, string content, string hash, Accumulator accumulator)
    {
        using var json = JsonDocument.Parse(content);
        if (String(json.RootElement, "schemaVersion") != "1.0") throw new JsonException("Trace relation sidecar schemaVersion must be 1.0");
        if (!json.RootElement.TryGetProperty("relations", out var relations) || relations.ValueKind != JsonValueKind.Array)
            throw new JsonException("Trace relation sidecar relations must be an array");
        hash = CanonicalJsonHash(json.RootElement);
        foreach (var relation in relations.EnumerateArray())
        {
            var type = RequiredString(relation, "relation");
            if (!relation.TryGetProperty("from", out var from) || !relation.TryGetProperty("to", out var to))
                throw new JsonException("Declared relation requires from and to endpoints");
            var fromType = RequiredString(from, "type"); var toType = RequiredString(to, "type");
            var fromRef = NormalizeRef(fromType, RequiredString(from, "canonicalRef"));
            var toRef = NormalizeRef(toType, RequiredString(to, "canonicalRef"));
            var evidence = String(relation, "evidenceRef") ?? document.CanonicalRef;
            accumulator.AddPending(type, Id(fromType, fromRef), Id(toType, toRef), "manifest", "declared", "T1",
                evidence, hash, document.CanonicalRef);
        }
    }

    private static TraceNodeInput Node(string type, string nodeNamespace, string canonicalRef, string title, string hash,
        string origin, string tier, string authority, object properties)
        => new(type, nodeNamespace, canonicalRef, title, hash, origin, tier,
            JsonSerializer.Serialize(properties), authority);

    private static string Id(string type, string canonicalRef) => TraceGraphRepository.ComputeNodeId(type, canonicalRef);
    private static string NormalizeRef(string type, string value)
    {
        var prefix = type + ":";
        return value.StartsWith(prefix, StringComparison.Ordinal) ? value[prefix.Length..] : value;
    }
    private static string InferSourceType(string value)
        => value.Contains("schema", StringComparison.OrdinalIgnoreCase) || value.StartsWith("contract:", StringComparison.Ordinal) ? "contract" : "file";
    private static string MapContextType(string type) => type switch
    { "contract" => "contract", "decision" => "adr", "symbol" => "symbol", "file" => "file", _ => "rule" };
    private static string MapSourceMapType(string kind, string canonical) => kind switch
    {
        "decision" => "adr", "source" => InferSourceType(canonical), "context-package" => "context-package",
        "contract" or "criterion" or "task" or "file" or "symbol" or "gate" or "evidence" or "commit" => kind,
        _ => "rule"
    };
    private static (string Relation, string From, string To) MapRelation(string relation, string from, string to) => relation switch
    {
        "requires" => ("depends_on", from, to),
        "implemented_by" => ("implements", to, from),
        "changed_by" => ("changes", to, from),
        "selected_for" or "verified_by" or "derived_from" => (relation, from, to),
        _ => throw new JsonException($"Unsupported source-map relation: {relation}")
    };
    private static string? String(JsonElement element, string property)
        => element.ValueKind == JsonValueKind.Object && element.TryGetProperty(property, out var value) && value.ValueKind == JsonValueKind.String ? value.GetString() : null;
    private static string RequiredString(JsonElement element, string property)
        => String(element, property) ?? throw new JsonException($"Required string property is missing: {property}");
    private static IEnumerable<string> FindStringProperties(JsonElement element, string property)
    {
        if (element.ValueKind == JsonValueKind.Object)
            foreach (var item in element.EnumerateObject())
            {
                if (item.NameEquals(property) && item.Value.ValueKind == JsonValueKind.String) yield return item.Value.GetString()!;
                foreach (var nested in FindStringProperties(item.Value, property)) yield return nested;
            }
        else if (element.ValueKind == JsonValueKind.Array)
            foreach (var item in element.EnumerateArray()) foreach (var nested in FindStringProperties(item, property)) yield return nested;
    }
    private static string Hash(byte[] value) => Convert.ToHexString(SHA256.HashData(value)).ToLowerInvariant();
    private static string? ValidHash(string? value)
        => value is not null && Sha256Regex().IsMatch(value) ? value : null;
    private static string CanonicalJsonHash(JsonElement element)
    {
        using var stream = new MemoryStream();
        using (var writer = new Utf8JsonWriter(stream)) WriteCanonical(writer, element);
        return Hash(stream.ToArray());
    }
    private static void WriteCanonical(Utf8JsonWriter writer, JsonElement element)
    {
        switch (element.ValueKind)
        {
            case JsonValueKind.Object:
                writer.WriteStartObject();
                foreach (var property in element.EnumerateObject().OrderBy(item => item.Name, StringComparer.Ordinal))
                { writer.WritePropertyName(property.Name); WriteCanonical(writer, property.Value); }
                writer.WriteEndObject(); break;
            case JsonValueKind.Array:
                writer.WriteStartArray(); foreach (var item in element.EnumerateArray()) WriteCanonical(writer, item); writer.WriteEndArray(); break;
            default: element.WriteTo(writer); break;
        }
    }
    private static TraceIngestDiagnostic Diagnostic(string code, string source, string message)
        => new(code, "error", source, message);

    private sealed class SymbolResolver
    {
        private readonly Dictionary<string, HashSet<string>> _symbols = new(StringComparer.Ordinal);
        public void Add(string name, string fullName)
        {
            AddKey(name, fullName); AddKey(fullName, fullName);
        }
        private void AddKey(string key, string fullName)
        { if (!_symbols.TryGetValue(key, out var values)) _symbols[key] = values = new(StringComparer.Ordinal); values.Add(fullName); }
        public SymbolResolution Resolve(string value) => new(_symbols.TryGetValue(value, out var values)
            ? values.OrderBy(item => item, StringComparer.Ordinal).ToList() : []);
    }
    private sealed record SymbolResolution(IReadOnlyList<string> Candidates);

    private sealed class Accumulator
    {
        private readonly Dictionary<string, (TraceNodeInput Node, string Source)> _nodes = new(StringComparer.Ordinal);
        private readonly List<PendingEdge> _pending = [];
        private readonly Dictionary<string, TraceEdgeInput> _edges = new(StringComparer.Ordinal);
        public IReadOnlyList<TraceNodeInput> Nodes => _nodes.OrderBy(item => item.Key, StringComparer.Ordinal).Select(item => item.Value.Node).ToList();
        public IReadOnlyList<TraceEdgeInput> Edges => _edges.OrderBy(item => item.Key, StringComparer.Ordinal).Select(item => item.Value).ToList();

        public void AddNode(TraceNodeInput node, string source, List<TraceIngestDiagnostic> diagnostics)
        {
            var id = Id(node.NodeType, node.CanonicalRef);
            if (!_nodes.TryGetValue(id, out var existing)) { _nodes[id] = (node, source); return; }
            if (existing.Node == node) return;
            diagnostics.Add(new TraceIngestDiagnostic("NODE_PROVENANCE_MERGED", "info", source,
                $"Multiple sources describe {node.NodeType}:{node.CanonicalRef}; deterministic precedence selected one", [existing.Source, source]));
            if (NodeScore(node) > NodeScore(existing.Node) || (NodeScore(node) == NodeScore(existing.Node)
                && string.CompareOrdinal(JsonSerializer.Serialize(node), JsonSerializer.Serialize(existing.Node)) < 0))
                _nodes[id] = (node, source);
        }
        public void AddPending(string relation, string from, string to, string origin, string confidence, string tier,
            string evidence, string hash, string source) => _pending.Add(new(relation, from, to, origin, confidence, tier, evidence, hash, source));
        public void ResolveEdges(List<TraceIngestDiagnostic> diagnostics)
        {
            foreach (var edge in _pending.OrderBy(item => item.Key, StringComparer.Ordinal))
            {
                if (!_nodes.ContainsKey(edge.From) || !_nodes.ContainsKey(edge.To))
                {
                    diagnostics.Add(new TraceIngestDiagnostic("EDGE_ENDPOINT_UNRESOLVED", "warning", edge.Source,
                        $"Skipped {edge.Relation} edge with unresolved endpoint: {edge.From} -> {edge.To}"));
                    continue;
                }
                var input = new TraceEdgeInput(edge.From, edge.To, edge.Relation, edge.Origin, edge.Confidence,
                    edge.Tier, edge.Evidence, edge.Hash, JsonSerializer.Serialize(new { sourceRef = edge.Source }));
                _edges.TryAdd(edge.Key, input);
            }
        }
        private static int NodeScore(TraceNodeInput node)
            => (node.Authority == "canonical" ? 100 : node.Authority == "advisory" ? 50 : node.Authority == "generated" ? 25 : 0)
               + (node.TrustTier == "T0" ? 20 : node.TrustTier == "T1" ? 10 : 0)
               + (node.Origin == "ast" ? 30 : node.Origin == "json-contract" ? 20 : node.Origin is "manifest" or "adr" ? 10 : 5)
               + (node.Title == node.CanonicalRef ? 0 : 5);
    }
    private sealed record PendingEdge(string Relation, string From, string To, string Origin, string Confidence,
        string Tier, string Evidence, string Hash, string Source)
    { public string Key => string.Join("\n", Relation, From, To, Evidence); }

    [GeneratedRegex("^#\\s+(.+)$", RegexOptions.Multiline | RegexOptions.CultureInvariant)] private static partial Regex HeadingRegex();
    [GeneratedRegex("(?:\\*\\*Status:\\*\\*|^status:)\\s*([A-Za-z-]+)", RegexOptions.IgnoreCase | RegexOptions.Multiline | RegexOptions.CultureInvariant)] private static partial Regex StatusRegex();
    [GeneratedRegex("^Supersedes:\\s*(.+)$", RegexOptions.IgnoreCase | RegexOptions.Multiline | RegexOptions.CultureInvariant)] private static partial Regex SupersedesRegex();
    [GeneratedRegex("ADR-[0-9]{4}", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant)] private static partial Regex AdrIdRegex();
    [GeneratedRegex("^[a-zA-Z]:[\\\\/]", RegexOptions.CultureInvariant)] private static partial Regex WindowsAbsolutePathRegex();
    [GeneratedRegex("^[0-9a-f]{64}$", RegexOptions.CultureInvariant)] private static partial Regex Sha256Regex();
}
