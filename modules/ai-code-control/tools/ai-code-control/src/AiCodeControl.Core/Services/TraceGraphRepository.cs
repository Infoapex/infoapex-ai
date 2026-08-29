using System.Security.Cryptography;
using System.Text;
using System.Text.Encodings.Web;
using System.Text.Json;
using System.Text.RegularExpressions;
using AiCodeControl.Core.Models;
using Microsoft.Data.Sqlite;

namespace AiCodeControl.Core.Services;

public sealed partial class TraceGraphRepository
{
    private static readonly HashSet<string> NodeTypes = new(StringComparer.Ordinal)
    {
        "adr", "rule", "contract", "criterion", "task", "run", "gate", "evidence",
        "commit", "file", "symbol", "context-package"
    };

    private static readonly HashSet<string> EdgeTypes = new(StringComparer.Ordinal)
    {
        "supersedes", "depends_on", "implements", "verified_by", "derived_from",
        "changes", "references", "selected_for"
    };

    private static readonly HashSet<string> Authorities = new(StringComparer.Ordinal)
    {
        "canonical", "advisory", "proposed", "generated"
    };

    private static readonly IReadOnlyDictionary<string, string> OriginTiers =
        new Dictionary<string, string>(StringComparer.Ordinal)
        {
            ["ast"] = "T0",
            ["git"] = "T0",
            ["json-contract"] = "T0",
            ["runtime-evidence"] = "T0",
            ["adr"] = "T1",
            ["frontmatter"] = "T1",
            ["manifest"] = "T1",
            ["model"] = "T2"
        };

    private static readonly IReadOnlyDictionary<string, string> TierConfidence =
        new Dictionary<string, string>(StringComparer.Ordinal)
        {
            ["T0"] = "deterministic",
            ["T1"] = "declared",
            ["T2"] = "inferred"
        };

    public static string ComputeNodeId(string nodeNamespace, string canonicalRef)
    {
        RequireNonEmpty(nodeNamespace, nameof(nodeNamespace));
        RequireNonEmpty(canonicalRef, nameof(canonicalRef));
        return "trace-node:" + Sha256($"{nodeNamespace.Trim()}\n{canonicalRef.Trim()}");
    }

    public static string ComputeEdgeId(string sourceNamespace, TraceEdgeInput edge)
    {
        RequireNonEmpty(sourceNamespace, nameof(sourceNamespace));
        ArgumentNullException.ThrowIfNull(edge);
        return "trace-edge:" + Sha256(string.Join("\n",
            sourceNamespace.Trim(), edge.FromNodeId.Trim(), edge.EdgeType.Trim(),
            edge.ToNodeId.Trim(), edge.Origin.Trim(), edge.EvidenceRef.Trim()));
    }

    public TraceGraphWriteResult ApplySnapshot(string databasePath, TraceGraphSnapshot snapshot)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(databasePath);
        var normalized = Normalize(snapshot);

        using var connection = Open(databasePath);
        using var transaction = connection.BeginTransaction();
        var result = Apply(connection, transaction, normalized, "incremental", null);
        transaction.Commit();
        return result;
    }

    public TraceGraphState Rebuild(string databasePath, IReadOnlyList<TraceGraphSnapshot> snapshots)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(databasePath);
        ArgumentNullException.ThrowIfNull(snapshots);
        var normalized = snapshots.Select(Normalize).OrderBy(item => item.SourceNamespace, StringComparer.Ordinal).ToList();
        if (normalized.Select(item => item.SourceNamespace).Distinct(StringComparer.Ordinal).Count() != normalized.Count)
            throw new ArgumentException("A full rebuild accepts at most one snapshot per source namespace", nameof(snapshots));

        var allNodeIds = normalized.SelectMany(item => item.Nodes).Select(item => item.NodeId).ToHashSet(StringComparer.Ordinal);
        foreach (var item in normalized)
            ValidateEdgeEndpoints(item, allNodeIds);

        using var connection = Open(databasePath);
        using var transaction = connection.BeginTransaction();
        Execute(connection, transaction, "DELETE FROM trace_edges; DELETE FROM trace_nodes; DELETE FROM trace_ingest_runs;");
        foreach (var item in normalized)
            Apply(connection, transaction, item, "rebuild", allNodeIds);
        var state = ReadState(connection, transaction, currentOnly: true);
        transaction.Commit();
        return state;
    }

    public TraceGraphWriteResult InvalidateSource(string databasePath, string sourceNamespace,
        string expectedSourceCommit, string invalidatedByCommit, DateTimeOffset effectiveAt)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(databasePath);
        RequireNonEmpty(sourceNamespace, nameof(sourceNamespace));
        RequireNonEmpty(expectedSourceCommit, nameof(expectedSourceCommit));
        var normalized = Normalize(new TraceGraphSnapshot(sourceNamespace, invalidatedByCommit,
            effectiveAt, [], []));

        using var connection = Open(databasePath);
        using var transaction = connection.BeginTransaction();
        using (var command = Command(connection, transaction,
                   "SELECT DISTINCT source_commit FROM trace_nodes WHERE source_namespace=$source AND valid_to IS NULL UNION SELECT DISTINCT source_commit FROM trace_edges WHERE source_namespace=$source AND valid_to IS NULL ORDER BY source_commit"))
        {
            Add(command, "$source", sourceNamespace);
            var commits = new List<string>();
            using var reader = command.ExecuteReader();
            while (reader.Read()) commits.Add(reader.GetString(0));
            if (commits.Count != 1 || !string.Equals(commits[0], expectedSourceCommit, StringComparison.Ordinal))
                throw new InvalidOperationException($"Trace source commit precondition failed for {sourceNamespace}");
        }

        var result = Apply(connection, transaction, normalized, "invalidate", null);
        transaction.Commit();
        return result;
    }

    public TraceGraphState ReadCurrent(string databasePath)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(databasePath);
        using var connection = Open(databasePath);
        return ReadState(connection, null, currentOnly: true);
    }

    public TraceGraphState ReadHistory(string databasePath)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(databasePath);
        using var connection = Open(databasePath);
        return ReadState(connection, null, currentOnly: false);
    }

    private static TraceGraphWriteResult Apply(
        SqliteConnection connection,
        SqliteTransaction transaction,
        NormalizedSnapshot snapshot,
        string mode,
        IReadOnlySet<string>? additionalAvailableNodeIds)
    {
        var currentNodes = ReadOwnedNodes(connection, transaction, snapshot.SourceNamespace)
            .ToDictionary(item => item.Version.NodeId, StringComparer.Ordinal);
        var currentEdges = ReadOwnedEdges(connection, transaction, snapshot.SourceNamespace)
            .ToDictionary(item => item.Version.EdgeId, StringComparer.Ordinal);
        var desiredNodes = snapshot.Nodes.ToDictionary(item => item.NodeId, StringComparer.Ordinal);
        var desiredEdges = snapshot.Edges.ToDictionary(item => item.EdgeId, StringComparer.Ordinal);

        var availableNodeIds = ReadCurrentNodeIdsFromOtherSources(connection, transaction, snapshot.SourceNamespace);
        var conflictingOwners = desiredNodes.Keys.Where(availableNodeIds.Contains).OrderBy(item => item, StringComparer.Ordinal).ToList();
        if (conflictingOwners.Count > 0)
            throw new InvalidOperationException($"Trace node identity is already owned by another source: {string.Join(", ", conflictingOwners)}");
        availableNodeIds.UnionWith(desiredNodes.Keys);
        if (additionalAvailableNodeIds is not null) availableNodeIds.UnionWith(additionalAvailableNodeIds);
        ValidateEdgeEndpoints(snapshot, availableNodeIds);

        var nodesExpired = 0;
        var nodesInserted = 0;
        var edgesExpired = 0;
        var edgesInserted = 0;
        var effectiveAt = snapshot.EffectiveAt.ToUniversalTime().ToString("O");
        var changesRequired = currentNodes.Values.Any(current =>
                !desiredNodes.TryGetValue(current.Version.NodeId, out var desired) || !Same(current.Version, desired, snapshot))
            || desiredNodes.Values.Any(desired =>
                !currentNodes.TryGetValue(desired.NodeId, out var current) || !Same(current.Version, desired, snapshot))
            || currentEdges.Values.Any(current =>
                !desiredEdges.TryGetValue(current.Version.EdgeId, out var desired) || !Same(current.Version, desired, snapshot))
            || desiredEdges.Values.Any(desired =>
                !currentEdges.TryGetValue(desired.EdgeId, out var current) || !Same(current.Version, desired, snapshot));
        var latestCurrentStart = currentNodes.Values.Select(item => item.Version.ValidFrom)
            .Concat(currentEdges.Values.Select(item => item.Version.ValidFrom))
            .DefaultIfEmpty(DateTimeOffset.MinValue)
            .Max();
        if (changesRequired && snapshot.EffectiveAt <= latestCurrentStart)
            throw new InvalidOperationException($"Trace snapshot EffectiveAt must be later than the current source version ({latestCurrentStart:O})");

        var removedNodeIds = currentNodes.Keys.Where(nodeId => !desiredNodes.ContainsKey(nodeId)).ToHashSet(StringComparer.Ordinal);
        EnsureNoForeignCurrentEdges(connection, transaction, snapshot.SourceNamespace, removedNodeIds);

        foreach (var current in currentEdges.Values)
        {
            if (!desiredEdges.TryGetValue(current.Version.EdgeId, out var desired) || !Same(current.Version, desired, snapshot))
            {
                Expire(connection, transaction, "trace_edges", current.VersionId, effectiveAt);
                edgesExpired++;
            }
        }

        foreach (var current in currentNodes.Values)
        {
            if (!desiredNodes.TryGetValue(current.Version.NodeId, out var desired) || !Same(current.Version, desired, snapshot))
            {
                Expire(connection, transaction, "trace_nodes", current.VersionId, effectiveAt);
                nodesExpired++;
            }
        }

        foreach (var desired in snapshot.Nodes)
        {
            if (currentNodes.TryGetValue(desired.NodeId, out var current) && Same(current.Version, desired, snapshot))
                continue;
            InsertNode(connection, transaction, desired, snapshot, effectiveAt);
            nodesInserted++;
        }

        foreach (var desired in snapshot.Edges)
        {
            if (currentEdges.TryGetValue(desired.EdgeId, out var current) && Same(current.Version, desired, snapshot))
                continue;
            InsertEdge(connection, transaction, desired, snapshot, effectiveAt);
            edgesInserted++;
        }

        InsertRun(connection, transaction, mode, snapshot, nodesInserted, nodesExpired, edgesInserted, edgesExpired);
        var digest = ReadState(connection, transaction, currentOnly: true).Digest;
        return new TraceGraphWriteResult(snapshot.SourceNamespace, snapshot.SourceCommit,
            nodesInserted, nodesExpired, edgesInserted, edgesExpired, digest);
    }

    private static NormalizedSnapshot Normalize(TraceGraphSnapshot snapshot)
    {
        ArgumentNullException.ThrowIfNull(snapshot);
        RequireNonEmpty(snapshot.SourceNamespace, nameof(snapshot.SourceNamespace));
        RequireNonEmpty(snapshot.SourceCommit, nameof(snapshot.SourceCommit));
        if (snapshot.EffectiveAt == default) throw new ArgumentException("EffectiveAt is required", nameof(snapshot));
        ArgumentNullException.ThrowIfNull(snapshot.Nodes);
        ArgumentNullException.ThrowIfNull(snapshot.Edges);

        var nodes = snapshot.Nodes.Select(node =>
        {
            ArgumentNullException.ThrowIfNull(node);
            if (!NodeTypes.Contains(node.NodeType)) throw new ArgumentException($"Unknown trace node type: {node.NodeType}", nameof(snapshot));
            ValidateOrigin(node.Origin, node.TrustTier);
            if (!Authorities.Contains(node.Authority)) throw new ArgumentException($"Unknown trace node authority: {node.Authority}", nameof(snapshot));
            ValidateHash(node.SourceHash, "node source hash");
            RequireNonEmpty(node.NodeNamespace, "node namespace");
            RequireNonEmpty(node.CanonicalRef, "node canonical ref");
            RequireNonEmpty(node.Title, "node title");
            var canonicalRef = node.NodeType == "file" ? NormalizeRepositoryPath(node.CanonicalRef) : node.CanonicalRef.Trim();
            return new NormalizedNode(ComputeNodeId(node.NodeNamespace, canonicalRef), node.NodeType,
                node.NodeNamespace.Trim(), canonicalRef, node.Title.Trim(), node.SourceHash,
                node.Origin, node.TrustTier, node.Authority, CanonicalObject(node.PropertiesJson));
        }).OrderBy(item => item.NodeId, StringComparer.Ordinal).ToList();

        if (nodes.Select(item => item.NodeId).Distinct(StringComparer.Ordinal).Count() != nodes.Count)
            throw new ArgumentException("Snapshot contains duplicate trace node identities", nameof(snapshot));

        var edges = snapshot.Edges.Select(edge =>
        {
            ArgumentNullException.ThrowIfNull(edge);
            if (!EdgeTypes.Contains(edge.EdgeType)) throw new ArgumentException($"Unknown trace edge type: {edge.EdgeType}", nameof(snapshot));
            ValidateOrigin(edge.Origin, edge.TrustTier);
            if (!TierConfidence.TryGetValue(edge.TrustTier, out var confidence) || !string.Equals(confidence, edge.Confidence, StringComparison.Ordinal))
                throw new ArgumentException($"Confidence {edge.Confidence} does not match trust tier {edge.TrustTier}", nameof(snapshot));
            ValidateHash(edge.SourceHash, "edge source hash");
            RequireNonEmpty(edge.FromNodeId, "edge from node id");
            RequireNonEmpty(edge.ToNodeId, "edge to node id");
            RequireNonEmpty(edge.EvidenceRef, "edge evidence ref");
            RejectAbsolutePath(edge.EvidenceRef, "edge evidence ref");
            return new NormalizedEdge(ComputeEdgeId(snapshot.SourceNamespace, edge), edge.FromNodeId.Trim(),
                edge.ToNodeId.Trim(), edge.EdgeType, edge.Origin, edge.Confidence, edge.TrustTier,
                edge.EvidenceRef.Trim(), edge.SourceHash, CanonicalObject(edge.PropertiesJson));
        }).OrderBy(item => item.EdgeId, StringComparer.Ordinal).ToList();

        if (edges.Select(item => item.EdgeId).Distinct(StringComparer.Ordinal).Count() != edges.Count)
            throw new ArgumentException("Snapshot contains duplicate trace edge identities", nameof(snapshot));

        return new NormalizedSnapshot(snapshot.SourceNamespace.Trim(), snapshot.SourceCommit.Trim(),
            snapshot.EffectiveAt.ToUniversalTime(), nodes, edges);
    }

    private static void ValidateOrigin(string origin, string trustTier)
    {
        if (!OriginTiers.TryGetValue(origin, out var expectedTier))
            throw new ArgumentException($"Unknown trace origin: {origin}");
        if (!string.Equals(expectedTier, trustTier, StringComparison.Ordinal))
            throw new ArgumentException($"Origin {origin} requires trust tier {expectedTier}, not {trustTier}");
    }

    private static void ValidateEdgeEndpoints(NormalizedSnapshot snapshot, IReadOnlySet<string> availableNodeIds)
    {
        foreach (var edge in snapshot.Edges)
        {
            if (!availableNodeIds.Contains(edge.FromNodeId) || !availableNodeIds.Contains(edge.ToNodeId))
                throw new ArgumentException($"Trace edge {edge.EdgeId} references a node that is not current or present in the rebuild");
        }
    }

    private static bool Same(TraceNodeVersion current, NormalizedNode desired, NormalizedSnapshot snapshot)
        => current.NodeType == desired.NodeType && current.NodeNamespace == desired.NodeNamespace
           && current.CanonicalRef == desired.CanonicalRef && current.Title == desired.Title
           && current.SourceHash == desired.SourceHash
           && current.Origin == desired.Origin && current.TrustTier == desired.TrustTier
           && current.Authority == desired.Authority
           && current.PropertiesJson == desired.PropertiesJson;

    private static bool Same(TraceEdgeVersion current, NormalizedEdge desired, NormalizedSnapshot snapshot)
        => current.FromNodeId == desired.FromNodeId && current.ToNodeId == desired.ToNodeId
           && current.EdgeType == desired.EdgeType && current.Origin == desired.Origin
           && current.Confidence == desired.Confidence && current.TrustTier == desired.TrustTier
           && current.EvidenceRef == desired.EvidenceRef && current.SourceHash == desired.SourceHash
           && current.PropertiesJson == desired.PropertiesJson;

    private static void InsertNode(SqliteConnection connection, SqliteTransaction transaction, NormalizedNode node, NormalizedSnapshot snapshot, string effectiveAt)
    {
        using var command = Command(connection, transaction, @"
INSERT INTO trace_nodes(node_id,node_type,node_namespace,canonical_ref,title,source_namespace,source_hash,source_commit,origin,trust_tier,authority,valid_from,valid_to,properties_json)
VALUES($id,$type,$namespace,$ref,$title,$sourceNamespace,$hash,$commit,$origin,$tier,$authority,$from,NULL,$properties);");
        Add(command, "$id", node.NodeId); Add(command, "$type", node.NodeType); Add(command, "$namespace", node.NodeNamespace);
        Add(command, "$ref", node.CanonicalRef); Add(command, "$title", node.Title); Add(command, "$sourceNamespace", snapshot.SourceNamespace);
        Add(command, "$hash", node.SourceHash); Add(command, "$commit", snapshot.SourceCommit); Add(command, "$origin", node.Origin);
        Add(command, "$tier", node.TrustTier); Add(command, "$authority", node.Authority); Add(command, "$from", effectiveAt); Add(command, "$properties", node.PropertiesJson);
        command.ExecuteNonQuery();
    }

    private static void InsertEdge(SqliteConnection connection, SqliteTransaction transaction, NormalizedEdge edge, NormalizedSnapshot snapshot, string effectiveAt)
    {
        using var command = Command(connection, transaction, @"
INSERT INTO trace_edges(edge_id,from_node_id,to_node_id,edge_type,origin,confidence,trust_tier,evidence_ref,source_namespace,source_hash,source_commit,valid_from,valid_to,properties_json)
VALUES($id,$fromNode,$toNode,$type,$origin,$confidence,$tier,$evidence,$sourceNamespace,$hash,$commit,$from,NULL,$properties);");
        Add(command, "$id", edge.EdgeId); Add(command, "$fromNode", edge.FromNodeId); Add(command, "$toNode", edge.ToNodeId);
        Add(command, "$type", edge.EdgeType); Add(command, "$origin", edge.Origin); Add(command, "$confidence", edge.Confidence);
        Add(command, "$tier", edge.TrustTier); Add(command, "$evidence", edge.EvidenceRef); Add(command, "$sourceNamespace", snapshot.SourceNamespace);
        Add(command, "$hash", edge.SourceHash); Add(command, "$commit", snapshot.SourceCommit); Add(command, "$from", effectiveAt);
        Add(command, "$properties", edge.PropertiesJson); command.ExecuteNonQuery();
    }

    private static void Expire(SqliteConnection connection, SqliteTransaction transaction, string table, long versionId, string effectiveAt)
    {
        using var command = Command(connection, transaction, $"UPDATE {table} SET valid_to=$to WHERE version_id=$id AND valid_to IS NULL");
        Add(command, "$to", effectiveAt); Add(command, "$id", versionId); command.ExecuteNonQuery();
    }

    private static void InsertRun(SqliteConnection connection, SqliteTransaction transaction, string mode, NormalizedSnapshot snapshot,
        int nodesInserted, int nodesExpired, int edgesInserted, int edgesExpired)
    {
        using var command = Command(connection, transaction, @"
INSERT INTO trace_ingest_runs(mode,source_namespace,source_commit,effective_at,completed_at,nodes_inserted,nodes_expired,edges_inserted,edges_expired)
VALUES($mode,$namespace,$commit,$effective,datetime('now'),$ni,$ne,$ei,$ee);");
        Add(command, "$mode", mode); Add(command, "$namespace", snapshot.SourceNamespace); Add(command, "$commit", snapshot.SourceCommit);
        Add(command, "$effective", snapshot.EffectiveAt.ToString("O")); Add(command, "$ni", nodesInserted); Add(command, "$ne", nodesExpired);
        Add(command, "$ei", edgesInserted); Add(command, "$ee", edgesExpired); command.ExecuteNonQuery();
    }

    private static List<StoredNode> ReadOwnedNodes(SqliteConnection connection, SqliteTransaction transaction, string sourceNamespace)
    {
        using var command = Command(connection, transaction, "SELECT version_id,node_id,node_type,node_namespace,canonical_ref,title,source_namespace,source_hash,source_commit,origin,trust_tier,authority,valid_from,valid_to,properties_json FROM trace_nodes WHERE source_namespace=$source AND valid_to IS NULL ORDER BY node_id");
        Add(command, "$source", sourceNamespace); var result = new List<StoredNode>();
        using var reader = command.ExecuteReader(); while (reader.Read()) result.Add(new StoredNode(reader.GetInt64(0), ReadNode(reader, 1)));
        return result;
    }

    private static List<StoredEdge> ReadOwnedEdges(SqliteConnection connection, SqliteTransaction transaction, string sourceNamespace)
    {
        using var command = Command(connection, transaction, "SELECT version_id,edge_id,from_node_id,to_node_id,edge_type,origin,confidence,trust_tier,evidence_ref,source_namespace,source_hash,source_commit,valid_from,valid_to,properties_json FROM trace_edges WHERE source_namespace=$source AND valid_to IS NULL ORDER BY edge_id");
        Add(command, "$source", sourceNamespace); var result = new List<StoredEdge>();
        using var reader = command.ExecuteReader(); while (reader.Read()) result.Add(new StoredEdge(reader.GetInt64(0), ReadEdge(reader, 1)));
        return result;
    }

    private static HashSet<string> ReadCurrentNodeIdsFromOtherSources(SqliteConnection connection, SqliteTransaction transaction, string sourceNamespace)
    {
        using var command = Command(connection, transaction, "SELECT node_id FROM trace_nodes WHERE source_namespace<>$source AND valid_to IS NULL ORDER BY node_id");
        Add(command, "$source", sourceNamespace); var result = new HashSet<string>(StringComparer.Ordinal);
        using var reader = command.ExecuteReader(); while (reader.Read()) result.Add(reader.GetString(0));
        return result;
    }

    private static void EnsureNoForeignCurrentEdges(SqliteConnection connection, SqliteTransaction transaction,
        string sourceNamespace, IReadOnlySet<string> removedNodeIds)
    {
        if (removedNodeIds.Count == 0) return;
        using var command = Command(connection, transaction, @"
SELECT edge_id,from_node_id,to_node_id
FROM trace_edges
WHERE source_namespace<>$source AND valid_to IS NULL
ORDER BY edge_id;");
        Add(command, "$source", sourceNamespace);
        using var reader = command.ExecuteReader();
        while (reader.Read())
        {
            if (removedNodeIds.Contains(reader.GetString(1)) || removedNodeIds.Contains(reader.GetString(2)))
                throw new InvalidOperationException($"Removing a trace node would orphan current edge {reader.GetString(0)} owned by another source");
        }
    }

    private static TraceGraphState ReadState(SqliteConnection connection, SqliteTransaction? transaction, bool currentOnly)
    {
        var nodes = new List<TraceNodeVersion>();
        using (var command = Command(connection, transaction, "SELECT node_id,node_type,node_namespace,canonical_ref,title,source_namespace,source_hash,source_commit,origin,trust_tier,authority,valid_from,valid_to,properties_json FROM trace_nodes" + (currentOnly ? " WHERE valid_to IS NULL" : "") + " ORDER BY node_id,valid_from"))
        using (var reader = command.ExecuteReader()) while (reader.Read()) nodes.Add(ReadNode(reader, 0));
        var edges = new List<TraceEdgeVersion>();
        using (var command = Command(connection, transaction, "SELECT edge_id,from_node_id,to_node_id,edge_type,origin,confidence,trust_tier,evidence_ref,source_namespace,source_hash,source_commit,valid_from,valid_to,properties_json FROM trace_edges" + (currentOnly ? " WHERE valid_to IS NULL" : "") + " ORDER BY edge_id,valid_from"))
        using (var reader = command.ExecuteReader()) while (reader.Read()) edges.Add(ReadEdge(reader, 0));
        return new TraceGraphState(nodes, edges, ComputeDigest(nodes, edges));
    }

    private static TraceNodeVersion ReadNode(SqliteDataReader reader, int offset) => new(
        reader.GetString(offset), reader.GetString(offset + 1), reader.GetString(offset + 2), reader.GetString(offset + 3),
        reader.GetString(offset + 4), reader.GetString(offset + 5), reader.GetString(offset + 6), reader.GetString(offset + 7),
        reader.GetString(offset + 8), reader.GetString(offset + 9), reader.GetString(offset + 10), DateTimeOffset.Parse(reader.GetString(offset + 11)),
        reader.IsDBNull(offset + 12) ? null : DateTimeOffset.Parse(reader.GetString(offset + 12)), reader.GetString(offset + 13));

    private static TraceEdgeVersion ReadEdge(SqliteDataReader reader, int offset) => new(
        reader.GetString(offset), reader.GetString(offset + 1), reader.GetString(offset + 2), reader.GetString(offset + 3),
        reader.GetString(offset + 4), reader.GetString(offset + 5), reader.GetString(offset + 6), reader.GetString(offset + 7),
        reader.GetString(offset + 8), reader.GetString(offset + 9), reader.GetString(offset + 10), DateTimeOffset.Parse(reader.GetString(offset + 11)),
        reader.IsDBNull(offset + 12) ? null : DateTimeOffset.Parse(reader.GetString(offset + 12)), reader.GetString(offset + 13));

    private static string ComputeDigest(IReadOnlyList<TraceNodeVersion> nodes, IReadOnlyList<TraceEdgeVersion> edges)
    {
        var json = JsonSerializer.Serialize(new { nodes, edges }, new JsonSerializerOptions { PropertyNamingPolicy = JsonNamingPolicy.CamelCase });
        return Sha256(json);
    }

    private static string CanonicalObject(string json)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(json);
        using var document = JsonDocument.Parse(json);
        if (document.RootElement.ValueKind != JsonValueKind.Object) throw new ArgumentException("Trace properties JSON must be an object");
        using var stream = new MemoryStream();
        using (var writer = new Utf8JsonWriter(stream, new JsonWriterOptions { Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping }))
            WriteCanonical(writer, document.RootElement);
        return Encoding.UTF8.GetString(stream.ToArray());
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

    private static SqliteConnection Open(string databasePath)
    {
        if (!File.Exists(databasePath)) throw new FileNotFoundException("Trace graph database was not initialized", databasePath);
        var connection = new SqliteConnection($"Data Source={databasePath}"); connection.Open(); return connection;
    }

    private static SqliteCommand Command(SqliteConnection connection, SqliteTransaction? transaction, string sql)
    { var command = connection.CreateCommand(); command.Transaction = transaction; command.CommandText = sql; return command; }

    private static void Execute(SqliteConnection connection, SqliteTransaction transaction, string sql)
    { using var command = Command(connection, transaction, sql); command.ExecuteNonQuery(); }

    private static void Add(SqliteCommand command, string name, object value) => command.Parameters.AddWithValue(name, value);
    private static string Sha256(string value) => Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(value))).ToLowerInvariant();
    private static void RequireNonEmpty(string value, string name) { if (string.IsNullOrWhiteSpace(value)) throw new ArgumentException($"{name} is required"); }
    private static void ValidateHash(string value, string name) { if (!Sha256Regex().IsMatch(value)) throw new ArgumentException($"{name} must be a lowercase SHA-256 value"); }
    private static string NormalizeRepositoryPath(string value)
    {
        RejectAbsolutePath(value, "file canonical ref");
        var normalized = value.Trim().Replace('\\', '/');
        if (normalized.Split('/', StringSplitOptions.RemoveEmptyEntries).Any(segment => segment == ".."))
            throw new ArgumentException("file canonical ref cannot traverse outside the repository");
        return normalized.TrimStart('/');
    }

    private static void RejectAbsolutePath(string value, string name)
    {
        if (Path.IsPathRooted(value) || WindowsAbsolutePathRegex().IsMatch(value))
            throw new ArgumentException($"{name} must not contain an absolute host path");
    }

    [GeneratedRegex("^[0-9a-f]{64}$", RegexOptions.CultureInvariant)]
    private static partial Regex Sha256Regex();

    [GeneratedRegex("^[a-zA-Z]:[\\\\/]", RegexOptions.CultureInvariant)]
    private static partial Regex WindowsAbsolutePathRegex();

    private sealed record NormalizedNode(string NodeId, string NodeType, string NodeNamespace, string CanonicalRef, string Title, string SourceHash, string Origin, string TrustTier, string Authority, string PropertiesJson);
    private sealed record NormalizedEdge(string EdgeId, string FromNodeId, string ToNodeId, string EdgeType, string Origin, string Confidence, string TrustTier, string EvidenceRef, string SourceHash, string PropertiesJson);
    private sealed record NormalizedSnapshot(string SourceNamespace, string SourceCommit, DateTimeOffset EffectiveAt, IReadOnlyList<NormalizedNode> Nodes, IReadOnlyList<NormalizedEdge> Edges);
    private sealed record StoredNode(long VersionId, TraceNodeVersion Version);
    private sealed record StoredEdge(long VersionId, TraceEdgeVersion Version);
}
