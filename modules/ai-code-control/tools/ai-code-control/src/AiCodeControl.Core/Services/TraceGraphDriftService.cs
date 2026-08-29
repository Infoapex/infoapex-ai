using System.Text.Json;
using System.Text.RegularExpressions;
using AiCodeControl.Core.Models;
using Microsoft.Data.Sqlite;

namespace AiCodeControl.Core.Services;

public sealed partial class TraceGraphDriftService
{
    private const long MaximumManifestBytes = 2 * 1024 * 1024;
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

    public TraceGraphDriftReport Check(TraceGraphDriftOptions options)
    {
        ArgumentNullException.ThrowIfNull(options);
        ArgumentException.ThrowIfNullOrWhiteSpace(options.RepositoryRoot);
        ArgumentException.ThrowIfNullOrWhiteSpace(options.DatabasePath);
        if (options.MinimumCoveragePercent is < 0 or > 100)
            throw new ArgumentOutOfRangeException(nameof(options), "MinimumCoveragePercent must be between 0 and 100.");

        var repositoryRoot = Path.GetFullPath(options.RepositoryRoot);
        var scopeRoot = ResolveScope(repositoryRoot, options.ScopePath);
        var scope = Path.GetRelativePath(repositoryRoot, scopeRoot).Replace('\\', '/');
        if (scope.Length == 0) scope = ".";
        var state = new TraceGraphRepository().ReadCurrent(options.DatabasePath);
        var findings = new List<TraceGraphDriftFinding>();
        if (state.Nodes.Count == 0)
            findings.Add(Finding("EMPTY_TRACE_GRAPH", "warning",
                "The current trace graph is empty; authoritative drift enforcement cannot pass."));

        CheckVocabularyAndEndpoints(state, findings);
        var ingestRuns = ReadLatestIngestRuns(options.DatabasePath);
        CheckProvenance(state, ingestRuns, options.ExpectedSourceCommit, findings);
        CheckIdentitiesAndTrust(state, findings);
        CheckSupersession(state, findings);

        var authoritativeNodeIds = state.Nodes
            .Where(IsAuthoritative)
            .Select(item => item.NodeId)
            .ToHashSet(StringComparer.Ordinal);
        var authoritativeNodes = state.Nodes.Where(item => authoritativeNodeIds.Contains(item.NodeId)).ToList();
        var authoritativeEdges = state.Edges
            .Where(item => item.TrustTier != "T2")
            .Where(item => authoritativeNodeIds.Contains(item.FromNodeId) && authoritativeNodeIds.Contains(item.ToNodeId))
            .ToList();

        if (options.SourceManifestPath is null)
            findings.Add(Finding("SOURCE_MANIFEST_NOT_DECLARED", "warning",
                "Canonical source presence cannot be enforced until a source manifest is declared."));
        CheckSourceManifest(repositoryRoot, scopeRoot, options.SourceManifestPath, state.Nodes, findings);
        var coverage = CheckCoverage(authoritativeNodes, authoritativeEdges, options.MinimumCoveragePercent, findings);
        var expected = CheckExpectedGraph(repositoryRoot, scopeRoot, options.ExpectedGraphPath,
            authoritativeNodes, authoritativeEdges, findings);
        var projection = CheckProjection(repositoryRoot, scopeRoot, options.ProjectionManifestPath,
            options.ExpectedSourceCommit, state.Digest, authoritativeNodes, authoritativeEdges, findings);

        var checks = new List<TraceGraphDriftCheck>
        {
            BuildCheck("graph_non_empty", findings, ["EMPTY_TRACE_GRAPH"]),
            BuildCheck("canonical_sources", findings,
                ["SOURCE_MANIFEST_NOT_DECLARED", "SOURCE_MANIFEST_INVALID", "SOURCE_REQUIRED_MISSING", "SOURCE_OPTIONAL_MISSING", "SOURCE_NOT_AUTHORITATIVE", "SOURCE_HASH_MISMATCH"],
                options.SourceManifestPath is null ? "No source manifest declared; release enforcement requires review." : null),
            BuildCheck("node_edge_integrity", findings,
                ["UNKNOWN_NODE_TYPE", "UNKNOWN_EDGE_TYPE", "DANGLING_EDGE", "HASH_INVALID"]),
            BuildCheck("source_provenance_and_freshness", findings,
                ["NODE_SOURCE_RUN_MISSING", "EDGE_SOURCE_RUN_MISSING", "SOURCE_COMMIT_STALE"]),
            BuildCheck("identity_and_trust", findings,
                ["AMBIGUOUS_CURRENT_IDENTITY", "T2_ADVISORY_PRESENT", "NON_AUTHORITATIVE_ENDPOINT"]),
            BuildCheck("supersession_consistency", findings,
                ["SUPERSESSION_BRANCH", "SUPERSESSION_CYCLE"]),
            BuildCheck("criterion_evidence_coverage", findings,
                ["EVIDENCE_CHAIN_INCOMPLETE", "TRACE_COVERAGE_BELOW_THRESHOLD"],
                coverage.Status == "not_applicable" ? "No authoritative criteria are present." : null,
                coverage.Status == "not_applicable" ? "not_applicable" : null),
            BuildCheck("expected_graph", findings,
                ["EXPECTED_GRAPH_INVALID", "EXPECTED_NODE_MISSING", "EXPECTED_NODE_UNEXPECTED", "EXPECTED_EDGE_MISSING", "EXPECTED_EDGE_UNEXPECTED"],
                expected.Status == "not_applicable" ? "No expected graph fixture declared." : null,
                expected.Status == "not_applicable" ? "not_applicable" : null),
            BuildCheck("projection_drift", findings,
                ["PROJECTION_MANIFEST_INVALID", "PROJECTION_DIGEST_MISMATCH", "PROJECTION_COMMIT_STALE", "PROJECTION_SOURCE_HASH_MISMATCH"],
                projection.Note, projection.Status == "not_applicable" ? "not_applicable" : null)
        };

        var status = findings.Any(item => item.Severity == "error")
            ? "FAIL"
            : findings.Any(item => item.Severity == "warning")
                ? "REVIEW_REQUIRED"
                : "PASS";
        var counts = new TraceGraphDriftCounts(
            state.Nodes.Count, state.Edges.Count, authoritativeNodes.Count, authoritativeEdges.Count,
            state.Nodes.Count(item => item.TrustTier == "T2"),
            state.Edges.Count(item => item.TrustTier == "T2"));
        return new TraceGraphDriftReport("1.0", status, scope, options.ExpectedSourceCommit,
            state.Digest, counts, coverage, checks,
            findings.OrderBy(item => item.Severity == "error" ? 0 : item.Severity == "warning" ? 1 : 2)
                .ThenBy(item => item.Code, StringComparer.Ordinal)
                .ThenBy(item => item.EntityRef, StringComparer.Ordinal)
                .ToList(),
            expected, projection);
    }

    private static void CheckVocabularyAndEndpoints(TraceGraphState state, List<TraceGraphDriftFinding> findings)
    {
        var nodeIds = state.Nodes.Select(item => item.NodeId).ToHashSet(StringComparer.Ordinal);
        foreach (var node in state.Nodes)
        {
            if (!NodeTypes.Contains(node.NodeType))
                findings.Add(Finding("UNKNOWN_NODE_TYPE", "error", $"Unknown current node type {node.NodeType}.", node.NodeId));
            if (!Sha256Regex().IsMatch(node.SourceHash))
                findings.Add(Finding("HASH_INVALID", "error", "Current node has an invalid source hash.", node.NodeId));
        }
        foreach (var edge in state.Edges)
        {
            if (!EdgeTypes.Contains(edge.EdgeType))
                findings.Add(Finding("UNKNOWN_EDGE_TYPE", "error", $"Unknown current edge type {edge.EdgeType}.", edge.EdgeId, [edge.EvidenceRef]));
            if (!nodeIds.Contains(edge.FromNodeId) || !nodeIds.Contains(edge.ToNodeId))
                findings.Add(Finding("DANGLING_EDGE", "error", "Current edge has a missing endpoint.", edge.EdgeId, [edge.EvidenceRef]));
            if (!Sha256Regex().IsMatch(edge.SourceHash))
                findings.Add(Finding("HASH_INVALID", "error", "Current edge has an invalid source hash.", edge.EdgeId, [edge.EvidenceRef]));
        }
    }

    private static void CheckProvenance(
        TraceGraphState state,
        IReadOnlyDictionary<string, IngestRun> ingestRuns,
        string? expectedCommit,
        List<TraceGraphDriftFinding> findings)
    {
        foreach (var source in state.Nodes.GroupBy(item => item.SourceNamespace, StringComparer.Ordinal))
        {
            if (!ingestRuns.ContainsKey(source.Key))
                findings.Add(Finding("NODE_SOURCE_RUN_MISSING", "error",
                    "Current nodes have no latest trace ingest run.", source.Key));
        }
        foreach (var source in state.Edges.GroupBy(item => item.SourceNamespace, StringComparer.Ordinal))
        {
            if (!ingestRuns.ContainsKey(source.Key))
                findings.Add(Finding("EDGE_SOURCE_RUN_MISSING", "error",
                    "Current edges have no latest trace ingest run.", source.Key,
                    source.Select(item => item.EvidenceRef).Distinct(StringComparer.Ordinal).Take(10).ToList()));
        }
        if (string.IsNullOrWhiteSpace(expectedCommit)) return;
        var activeSources = state.Nodes.Select(item => item.SourceNamespace)
            .Concat(state.Edges.Select(item => item.SourceNamespace))
            .Distinct(StringComparer.Ordinal);
        foreach (var source in activeSources)
        {
            if (ingestRuns.TryGetValue(source, out var run) &&
                !string.Equals(run.SourceCommit, expectedCommit, StringComparison.Ordinal))
                findings.Add(Finding("SOURCE_COMMIT_STALE", "error",
                    $"Latest ingest commit {run.SourceCommit} does not match expected commit {expectedCommit}.", source));
        }
    }

    private static void CheckIdentitiesAndTrust(TraceGraphState state, List<TraceGraphDriftFinding> findings)
    {
        foreach (var group in state.Nodes.GroupBy(item => $"{item.NodeType}:{item.CanonicalRef}", StringComparer.OrdinalIgnoreCase)
                     .Where(item => item.Count() > 1))
            findings.Add(Finding("AMBIGUOUS_CURRENT_IDENTITY", "warning",
                "Multiple current nodes share the same type and canonical reference.", group.Key));

        var t2Nodes = state.Nodes.Count(item => item.TrustTier == "T2");
        var t2Edges = state.Edges.Count(item => item.TrustTier == "T2");
        if (t2Nodes + t2Edges > 0)
            findings.Add(Finding("T2_ADVISORY_PRESENT", "warning",
                $"Graph contains {t2Nodes} T2 node(s) and {t2Edges} T2 edge(s); they are excluded from enforcement."));

        var nodes = state.Nodes.ToDictionary(item => item.NodeId, StringComparer.Ordinal);
        foreach (var edge in state.Edges.Where(item => item.TrustTier != "T2"))
        {
            if ((nodes.TryGetValue(edge.FromNodeId, out var from) && !IsAuthoritative(from)) ||
                (nodes.TryGetValue(edge.ToNodeId, out var to) && !IsAuthoritative(to)))
                findings.Add(Finding("NON_AUTHORITATIVE_ENDPOINT", "warning",
                    "T0/T1 edge touches a proposed or advisory node and is excluded from enforcement.",
                    edge.EdgeId, [edge.EvidenceRef]));
        }
    }

    private static void CheckSupersession(TraceGraphState state, List<TraceGraphDriftFinding> findings)
    {
        var authoritativeIds = state.Nodes.Where(IsAuthoritative).Select(item => item.NodeId)
            .ToHashSet(StringComparer.Ordinal);
        var supersedes = state.Edges
            .Where(item => item.EdgeType == "supersedes" && item.TrustTier != "T2")
            .Where(item => authoritativeIds.Contains(item.FromNodeId) && authoritativeIds.Contains(item.ToNodeId))
            .ToList();
        foreach (var group in supersedes.GroupBy(item => item.ToNodeId, StringComparer.Ordinal).Where(item => item.Count() > 1))
            findings.Add(Finding("SUPERSESSION_BRANCH", "error",
                "Multiple authoritative current entities supersede the same node.", group.Key,
                group.Select(item => item.EvidenceRef).Distinct(StringComparer.Ordinal).ToList()));

        var adjacency = supersedes.GroupBy(item => item.FromNodeId, StringComparer.Ordinal)
            .ToDictionary(item => item.Key, item => item.Select(edge => edge.ToNodeId).ToList(), StringComparer.Ordinal);
        var visiting = new HashSet<string>(StringComparer.Ordinal);
        var visited = new HashSet<string>(StringComparer.Ordinal);
        foreach (var nodeId in authoritativeIds)
            if (HasCycle(nodeId, adjacency, visiting, visited))
            {
                findings.Add(Finding("SUPERSESSION_CYCLE", "error",
                    "Authoritative supersession lineage contains a cycle.", nodeId,
                    supersedes.Where(item => item.FromNodeId == nodeId || item.ToNodeId == nodeId)
                        .Select(item => item.EvidenceRef).Distinct(StringComparer.Ordinal).ToList()));
                break;
            }
    }

    private static bool HasCycle(
        string nodeId,
        IReadOnlyDictionary<string, List<string>> adjacency,
        HashSet<string> visiting,
        HashSet<string> visited)
    {
        if (visiting.Contains(nodeId)) return true;
        if (!visited.Add(nodeId)) return false;
        visiting.Add(nodeId);
        if (adjacency.TryGetValue(nodeId, out var targets))
            foreach (var target in targets)
                if (HasCycle(target, adjacency, visiting, visited)) return true;
        visiting.Remove(nodeId);
        return false;
    }

    private static void CheckSourceManifest(
        string repositoryRoot,
        string scopeRoot,
        string? manifestPath,
        IReadOnlyList<TraceNodeVersion> currentNodes,
        List<TraceGraphDriftFinding> findings)
    {
        if (manifestPath is null) return;
        try
        {
            using var document = ReadDeclaredJson(repositoryRoot, scopeRoot, manifestPath);
            RequireSchemaVersion(document.RootElement);
            var sources = RequiredArray(document.RootElement, "sources");
            var sourceKeys = new HashSet<string>(StringComparer.Ordinal);
            foreach (var source in sources.EnumerateArray())
            {
                var type = RequiredString(source, "nodeType");
                var canonicalRef = RequiredString(source, "canonicalRef");
                ValidateNodeType(type);
                ValidateCanonicalRef(canonicalRef);
                if (!sourceKeys.Add($"{type}:{canonicalRef}"))
                    throw new JsonException($"Duplicate canonical source {type}:{canonicalRef}.");
                var required = RequiredBoolean(source, "required");
                var matchingCurrent = currentNodes
                    .Where(item => item.NodeType == type && item.CanonicalRef == canonicalRef).ToList();
                var matching = matchingCurrent.Where(IsAuthoritative).ToList();
                if (matching.Count == 0)
                {
                    if (matchingCurrent.Count > 0)
                    {
                        findings.Add(Finding("SOURCE_NOT_AUTHORITATIVE", required ? "error" : "warning",
                            "Declared canonical source exists only with proposed or advisory authority.",
                            $"{type}:{canonicalRef}", [NormalizeDeclaredPath(repositoryRoot, scopeRoot, manifestPath)]));
                        continue;
                    }
                    var code = required ? "SOURCE_REQUIRED_MISSING" : "SOURCE_OPTIONAL_MISSING";
                    findings.Add(Finding(code, required ? "error" : "warning",
                        $"{(required ? "Required" : "Optional")} canonical source has no authoritative current node.",
                        $"{type}:{canonicalRef}", [NormalizeDeclaredPath(repositoryRoot, scopeRoot, manifestPath)]));
                    continue;
                }
                if (source.TryGetProperty("sourceHash", out var sourceHash))
                {
                    var expectedHash = sourceHash.GetString() ?? "";
                    ValidateHash(expectedHash, "sourceHash");
                    if (!matching.Any(item => item.SourceHash == expectedHash))
                        findings.Add(Finding("SOURCE_HASH_MISMATCH", "error",
                            "Canonical source node does not match the declared source hash.",
                            $"{type}:{canonicalRef}", [NormalizeDeclaredPath(repositoryRoot, scopeRoot, manifestPath)]));
                }
            }
        }
        catch (Exception exception) when (exception is JsonException or IOException or UnauthorizedAccessException or ArgumentException or InvalidOperationException)
        {
            findings.Add(Finding("SOURCE_MANIFEST_INVALID", "error", ControlErrorMessage(exception),
                NormalizeDeclaredPathForFinding(repositoryRoot, manifestPath)));
        }
    }

    private static TraceGraphCoverage CheckCoverage(
        IReadOnlyList<TraceNodeVersion> nodes,
        IReadOnlyList<TraceEdgeVersion> edges,
        decimal minimumPercent,
        List<TraceGraphDriftFinding> findings)
    {
        var nodeMap = nodes.ToDictionary(item => item.NodeId, StringComparer.Ordinal);
        var criteria = nodes.Where(item => item.NodeType == "criterion")
            .OrderBy(item => item.CanonicalRef, StringComparer.Ordinal).ToList();
        if (criteria.Count == 0)
            return new TraceGraphCoverage("not_applicable", minimumPercent, 0, 0, null, []);

        var incomplete = new List<string>();
        foreach (var criterion in criteria)
        {
            var taskEdges = edges.Where(item => item.EdgeType == "implements" && item.ToNodeId == criterion.NodeId)
                .Where(item => nodeMap.TryGetValue(item.FromNodeId, out var node) && node.NodeType == "task").ToList();
            var gateEdges = edges.Where(item => item.EdgeType == "verified_by" && item.FromNodeId == criterion.NodeId)
                .Where(item => nodeMap.TryGetValue(item.ToNodeId, out var node) && node.NodeType == "gate").ToList();
            var gateIds = gateEdges.Select(item => item.ToNodeId).ToHashSet(StringComparer.Ordinal);
            var evidenceEdges = edges.Where(item => item.EdgeType == "verified_by" && gateIds.Contains(item.FromNodeId))
                .Where(item => nodeMap.TryGetValue(item.ToNodeId, out var node) && node.NodeType == "evidence").ToList();
            if (taskEdges.Count > 0 && gateEdges.Count > 0 && evidenceEdges.Count > 0) continue;
            incomplete.Add(criterion.CanonicalRef);
            findings.Add(Finding("EVIDENCE_CHAIN_INCOMPLETE", "warning",
                "Criterion lacks a complete task -> criterion -> gate -> evidence chain.",
                $"criterion:{criterion.CanonicalRef}",
                taskEdges.Concat(gateEdges).Concat(evidenceEdges).Select(item => item.EvidenceRef)
                    .Distinct(StringComparer.Ordinal).ToList()));
        }
        var complete = criteria.Count - incomplete.Count;
        var percent = Math.Round(100m * complete / criteria.Count, 2);
        if (percent < minimumPercent)
            findings.Add(Finding("TRACE_COVERAGE_BELOW_THRESHOLD", "error",
                $"Trace evidence coverage {percent}% is below required {minimumPercent}%."));
        return new TraceGraphCoverage(percent >= minimumPercent ? "pass" : "fail",
            minimumPercent, criteria.Count, complete, percent, incomplete);
    }

    private static TraceGraphExpectedDiff CheckExpectedGraph(
        string repositoryRoot,
        string scopeRoot,
        string? expectedPath,
        IReadOnlyList<TraceNodeVersion> nodes,
        IReadOnlyList<TraceEdgeVersion> edges,
        List<TraceGraphDriftFinding> findings)
    {
        if (expectedPath is null)
            return new TraceGraphExpectedDiff("not_applicable", null, [], [], [], []);
        try
        {
            var normalizedPath = NormalizeDeclaredPath(repositoryRoot, scopeRoot, expectedPath);
            using var document = ReadDeclaredJson(repositoryRoot, scopeRoot, expectedPath);
            RequireSchemaVersion(document.RootElement);
            var mode = document.RootElement.TryGetProperty("mode", out var modeValue)
                ? modeValue.GetString() ?? "exact" : "exact";
            if (mode is not ("exact" or "subset")) throw new JsonException("Expected graph mode must be exact or subset.");
            var expectedNodeList = RequiredArray(document.RootElement, "nodes").EnumerateArray()
                .Select(NodeKey).ToList();
            var expectedEdgeList = RequiredArray(document.RootElement, "edges").EnumerateArray()
                .Select(ExpectedEdgeKey).ToList();
            var expectedNodes = expectedNodeList.ToHashSet(StringComparer.Ordinal);
            var expectedEdges = expectedEdgeList.ToHashSet(StringComparer.Ordinal);
            if (expectedNodes.Count != expectedNodeList.Count) throw new JsonException("Expected graph contains duplicate nodes.");
            if (expectedEdges.Count != expectedEdgeList.Count) throw new JsonException("Expected graph contains duplicate edges.");
            var nodeMap = nodes.ToDictionary(item => item.NodeId, item => NodeKey(item), StringComparer.Ordinal);
            var actualNodes = nodeMap.Values.ToHashSet(StringComparer.Ordinal);
            var actualEdges = edges.Where(item => nodeMap.ContainsKey(item.FromNodeId) && nodeMap.ContainsKey(item.ToNodeId))
                .Select(item => EdgeKey(nodeMap[item.FromNodeId], item.EdgeType, nodeMap[item.ToNodeId],
                    item.EvidenceRef, item.TrustTier)).ToHashSet(StringComparer.Ordinal);
            var missingNodes = expectedNodes.Except(actualNodes, StringComparer.Ordinal).OrderBy(item => item, StringComparer.Ordinal).ToList();
            var unexpectedNodes = mode == "exact"
                ? actualNodes.Except(expectedNodes, StringComparer.Ordinal).OrderBy(item => item, StringComparer.Ordinal).ToList() : [];
            var missingEdges = expectedEdges.Except(actualEdges, StringComparer.Ordinal).OrderBy(item => item, StringComparer.Ordinal).ToList();
            var unexpectedEdges = mode == "exact"
                ? actualEdges.Except(expectedEdges, StringComparer.Ordinal).OrderBy(item => item, StringComparer.Ordinal).ToList() : [];
            AddDiffFindings("EXPECTED_NODE_MISSING", missingNodes, "Expected authoritative node is missing.", normalizedPath, findings);
            AddDiffFindings("EXPECTED_NODE_UNEXPECTED", unexpectedNodes, "Unexpected authoritative node is present.", normalizedPath, findings);
            AddDiffFindings("EXPECTED_EDGE_MISSING", missingEdges, "Expected authoritative edge is missing.", normalizedPath, findings);
            AddDiffFindings("EXPECTED_EDGE_UNEXPECTED", unexpectedEdges, "Unexpected authoritative edge is present.", normalizedPath, findings);
            var status = missingNodes.Count + unexpectedNodes.Count + missingEdges.Count + unexpectedEdges.Count == 0 ? "pass" : "fail";
            return new TraceGraphExpectedDiff(status, mode, missingNodes, unexpectedNodes, missingEdges, unexpectedEdges);
        }
        catch (Exception exception) when (exception is JsonException or IOException or UnauthorizedAccessException or ArgumentException or InvalidOperationException)
        {
            findings.Add(Finding("EXPECTED_GRAPH_INVALID", "error", ControlErrorMessage(exception),
                NormalizeDeclaredPathForFinding(repositoryRoot, expectedPath)));
            return new TraceGraphExpectedDiff("fail", null, [], [], [], []);
        }
    }

    private static TraceGraphProjectionCheck CheckProjection(
        string repositoryRoot,
        string scopeRoot,
        string? projectionPath,
        string? expectedCommit,
        string actualDigest,
        IReadOnlyList<TraceNodeVersion> nodes,
        IReadOnlyList<TraceEdgeVersion> edges,
        List<TraceGraphDriftFinding> findings)
    {
        if (projectionPath is null)
            return new TraceGraphProjectionCheck("not_applicable", null, null, actualDigest,
                "GRAPH-04 projection manifest was not declared.");
        var normalizedPath = NormalizeDeclaredPathForFinding(repositoryRoot, projectionPath);
        try
        {
            using var document = ReadDeclaredJson(repositoryRoot, scopeRoot, projectionPath);
            RequireSchemaVersion(document.RootElement);
            var digest = RequiredString(document.RootElement, "graphDigest");
            var sourceCommit = RequiredString(document.RootElement, "sourceCommit");
            ValidateHash(digest, "graphDigest");
            if (digest != actualDigest)
                findings.Add(Finding("PROJECTION_DIGEST_MISMATCH", "error",
                    "Projection manifest graph digest does not match current SQLite state.", normalizedPath));
            if (!string.IsNullOrWhiteSpace(expectedCommit) && sourceCommit != expectedCommit)
                findings.Add(Finding("PROJECTION_COMMIT_STALE", "error",
                    "Projection manifest source commit does not match the expected repository commit.", normalizedPath));

            var actualHashes = nodes.Select(item => $"{item.SourceNamespace}:{item.SourceHash}")
                .Concat(edges.Select(item => $"{item.SourceNamespace}:{item.SourceHash}"))
                .ToHashSet(StringComparer.Ordinal);
            var declaredHashList = RequiredArray(document.RootElement, "sourceHashes").EnumerateArray()
                .Select(item =>
                {
                    var sourceNamespace = RequiredString(item, "sourceNamespace");
                    var sourceHash = RequiredString(item, "sourceHash");
                    ValidateHash(sourceHash, "sourceHash");
                    return $"{sourceNamespace}:{sourceHash}";
                })
                .ToList();
            var declaredHashes = declaredHashList.ToHashSet(StringComparer.Ordinal);
            if (declaredHashes.Count != declaredHashList.Count)
                throw new JsonException("Projection manifest contains duplicate source hashes.");
            if (!actualHashes.SetEquals(declaredHashes))
                findings.Add(Finding("PROJECTION_SOURCE_HASH_MISMATCH", "error",
                    "Projection manifest source hash set does not match current authoritative graph state.", normalizedPath));
            var failed = findings.Any(item => item.Code.StartsWith("PROJECTION_", StringComparison.Ordinal) && item.Severity == "error");
            return new TraceGraphProjectionCheck(failed ? "fail" : "pass", normalizedPath, digest, actualDigest);
        }
        catch (Exception exception) when (exception is JsonException or IOException or UnauthorizedAccessException or ArgumentException or InvalidOperationException)
        {
            var message = ControlErrorMessage(exception);
            findings.Add(Finding("PROJECTION_MANIFEST_INVALID", "error", message, normalizedPath));
            return new TraceGraphProjectionCheck("fail", normalizedPath, null, actualDigest, message);
        }
    }

    private static IReadOnlyDictionary<string, IngestRun> ReadLatestIngestRuns(string databasePath)
    {
        var result = new Dictionary<string, IngestRun>(StringComparer.Ordinal);
        using var connection = new SqliteConnection($"Data Source={databasePath}");
        connection.Open();
        using var command = connection.CreateCommand();
        command.CommandText = @"
SELECT runs.source_namespace, runs.source_commit, runs.completed_at
FROM trace_ingest_runs runs
JOIN (SELECT source_namespace, MAX(id) AS latest_id FROM trace_ingest_runs GROUP BY source_namespace) latest
  ON latest.latest_id = runs.id
ORDER BY runs.source_namespace;";
        using var reader = command.ExecuteReader();
        while (reader.Read())
            result[reader.GetString(0)] = new IngestRun(reader.GetString(1), reader.GetString(2));
        return result;
    }

    private static TraceGraphDriftCheck BuildCheck(
        string name,
        IReadOnlyList<TraceGraphDriftFinding> findings,
        string[] codes,
        string? note = null,
        string? forcedStatus = null)
    {
        var relevant = findings.Where(item => codes.Contains(item.Code)).ToList();
        var status = forcedStatus ?? (relevant.Any(item => item.Severity == "error")
            ? "fail"
            : relevant.Any(item => item.Severity == "warning") ? "review" : "pass");
        return new TraceGraphDriftCheck(name, status, relevant.Count, note);
    }

    private static bool IsAuthoritative(TraceNodeVersion node)
        => node.TrustTier != "T2" && node.Authority is not ("advisory" or "proposed");

    private static string NodeKey(TraceNodeVersion node) => $"{node.NodeType}:{node.CanonicalRef}";
    private static string NodeKey(JsonElement node)
    {
        var type = RequiredString(node, "nodeType");
        var canonicalRef = RequiredString(node, "canonicalRef");
        ValidateNodeType(type);
        ValidateCanonicalRef(canonicalRef);
        return $"{type}:{canonicalRef}";
    }

    private static string ExpectedEdgeKey(JsonElement edge)
    {
        if (!edge.TryGetProperty("from", out var from) || from.ValueKind != JsonValueKind.Object ||
            !edge.TryGetProperty("to", out var to) || to.ValueKind != JsonValueKind.Object)
            throw new JsonException("Expected graph edge requires from and to objects.");
        var relation = RequiredString(edge, "relation");
        var evidence = RequiredString(edge, "evidenceRef");
        var tier = RequiredString(edge, "trustTier");
        if (!EdgeTypes.Contains(relation)) throw new JsonException($"Unknown expected edge relation {relation}.");
        if (tier is not ("T0" or "T1")) throw new JsonException("Expected authoritative edge trustTier must be T0 or T1.");
        RejectAbsolute(evidence, "evidenceRef");
        return EdgeKey(NodeKey(from), relation, NodeKey(to), evidence, tier);
    }
    private static string EdgeKey(string from, string relation, string to, string evidence, string tier)
        => string.Join("|", from, relation, to, evidence, tier);

    private static void AddDiffFindings(
        string code,
        IReadOnlyList<string> values,
        string message,
        string expectedPath,
        List<TraceGraphDriftFinding> findings)
    {
        foreach (var value in values)
            findings.Add(Finding(code, "error", message, value, [expectedPath]));
    }

    private static JsonDocument ReadDeclaredJson(string repositoryRoot, string scopeRoot, string declaredPath)
    {
        var path = ResolveDeclaredPath(repositoryRoot, scopeRoot, declaredPath);
        var info = new FileInfo(path);
        if (!info.Exists) throw new FileNotFoundException("Declared graph control file does not exist.", path);
        if (info.Length > MaximumManifestBytes) throw new IOException($"Declared graph control file exceeds {MaximumManifestBytes} bytes.");
        return JsonDocument.Parse(File.ReadAllText(path));
    }

    private static string ResolveScope(string repositoryRoot, string scopePath)
    {
        var path = Path.GetFullPath(Path.IsPathRooted(scopePath)
            ? scopePath : Path.Combine(repositoryRoot, scopePath));
        EnsureWithin(repositoryRoot, path, "Scope");
        if (!string.Equals(path.TrimEnd(Path.DirectorySeparatorChar), repositoryRoot.TrimEnd(Path.DirectorySeparatorChar),
                StringComparison.OrdinalIgnoreCase))
            throw new ArgumentException("Graph drift v1 supports repository-root scope only.");
        return path;
    }

    private static string ResolveDeclaredPath(string repositoryRoot, string scopeRoot, string declaredPath)
    {
        var path = Path.GetFullPath(Path.IsPathRooted(declaredPath)
            ? declaredPath : Path.Combine(repositoryRoot, declaredPath));
        EnsureWithin(scopeRoot, path, "Declared graph control file");
        return path;
    }

    private static void EnsureWithin(string parent, string path, string label)
    {
        var relative = Path.GetRelativePath(parent, path);
        if (Path.IsPathRooted(relative) || relative == ".." ||
            relative.StartsWith($"..{Path.DirectorySeparatorChar}", StringComparison.Ordinal))
            throw new ArgumentException($"{label} must remain within the configured scope.");
    }

    private static string NormalizeDeclaredPath(string repositoryRoot, string scopeRoot, string declaredPath)
        => Path.GetRelativePath(repositoryRoot, ResolveDeclaredPath(repositoryRoot, scopeRoot, declaredPath)).Replace('\\', '/');

    private static string NormalizeDeclaredPathForFinding(string repositoryRoot, string? declaredPath)
    {
        if (string.IsNullOrWhiteSpace(declaredPath)) return ".";
        if (!Path.IsPathRooted(declaredPath)) return declaredPath.Replace('\\', '/');
        var full = Path.GetFullPath(declaredPath);
        var relative = Path.GetRelativePath(repositoryRoot, full);
        return Path.IsPathRooted(relative) || relative.StartsWith("..", StringComparison.Ordinal)
            ? "<outside-scope>" : relative.Replace('\\', '/');
    }

    private static string ControlErrorMessage(Exception exception)
        => exception switch
        {
            JsonException => exception.Message,
            ArgumentException => exception.Message,
            FileNotFoundException => "Declared graph control file does not exist.",
            UnauthorizedAccessException => "Declared graph control file is not readable.",
            IOException => "Declared graph control file could not be read safely.",
            InvalidOperationException => "Declared graph control file has an invalid value.",
            _ => "Declared graph control file is invalid."
        };

    private static void RequireSchemaVersion(JsonElement root)
    {
        if (root.ValueKind != JsonValueKind.Object || RequiredString(root, "schemaVersion") != "1.0")
            throw new JsonException("Graph control document schemaVersion must be 1.0.");
    }

    private static JsonElement RequiredArray(JsonElement element, string property)
    {
        if (!element.TryGetProperty(property, out var value) || value.ValueKind != JsonValueKind.Array)
            throw new JsonException($"Required array {property} is missing.");
        return value;
    }

    private static string RequiredString(JsonElement element, string property)
    {
        if (!element.TryGetProperty(property, out var value) || value.ValueKind != JsonValueKind.String ||
            string.IsNullOrWhiteSpace(value.GetString()))
            throw new JsonException($"Required string {property} is missing.");
        return value.GetString()!;
    }

    private static bool RequiredBoolean(JsonElement element, string property)
    {
        if (!element.TryGetProperty(property, out var value) ||
            value.ValueKind is not (JsonValueKind.True or JsonValueKind.False))
            throw new JsonException($"Required boolean {property} is missing.");
        return value.GetBoolean();
    }

    private static void ValidateNodeType(string type)
    {
        if (!NodeTypes.Contains(type)) throw new JsonException($"Unknown trace node type {type}.");
    }

    private static void ValidateCanonicalRef(string canonicalRef)
        => RejectAbsolute(canonicalRef, "canonicalRef");

    private static void ValidateHash(string hash, string property)
    {
        if (!Sha256Regex().IsMatch(hash)) throw new JsonException($"{property} must be a lowercase SHA-256 value.");
    }

    private static void RejectAbsolute(string value, string property)
    {
        if (Path.IsPathRooted(value) || WindowsAbsolutePathRegex().IsMatch(value) ||
            value.StartsWith("file:", StringComparison.OrdinalIgnoreCase))
            throw new JsonException($"{property} must not contain an absolute host path.");
    }

    private static TraceGraphDriftFinding Finding(
        string code,
        string severity,
        string message,
        string? entityRef = null,
        IReadOnlyList<string>? evidenceRefs = null)
        => new(code, severity, message, entityRef, evidenceRefs);

    [GeneratedRegex("^[0-9a-f]{64}$", RegexOptions.CultureInvariant)]
    private static partial Regex Sha256Regex();

    [GeneratedRegex("^[a-zA-Z]:[\\/]", RegexOptions.CultureInvariant)]
    private static partial Regex WindowsAbsolutePathRegex();

    private sealed record IngestRun(string SourceCommit, string CompletedAt);
}
