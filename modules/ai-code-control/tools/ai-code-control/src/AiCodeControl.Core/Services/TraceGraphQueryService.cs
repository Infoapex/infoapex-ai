using System.Diagnostics;
using AiCodeControl.Core.Models;
using Microsoft.Data.Sqlite;

namespace AiCodeControl.Core.Services;

public sealed class TraceGraphQueryService
{
    private const int MaximumAllowedDepth = 10;
    private const int MaximumAllowedNodes = 200;
    private const int MaximumAllowedEdges = 500;

    private static readonly IReadOnlyDictionary<string, IReadOnlySet<string>?> RootTypes =
        new Dictionary<string, IReadOnlySet<string>?>(StringComparer.Ordinal)
        {
            ["trace"] = null,
            ["why"] = new HashSet<string>(["symbol", "file"], StringComparer.Ordinal),
            ["affected"] = new HashSet<string>(["contract", "adr"], StringComparer.Ordinal),
            ["current"] = new HashSet<string>(["adr", "rule"], StringComparer.Ordinal),
            ["evidence-for"] = new HashSet<string>(["criterion", "task"], StringComparer.Ordinal)
        };

    public TraceGraphQueryResult Query(
        string databasePath,
        string kind,
        string entity,
        TraceGraphQueryOptions? options = null)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(databasePath);
        ArgumentException.ThrowIfNullOrWhiteSpace(kind);
        ArgumentException.ThrowIfNullOrWhiteSpace(entity);
        if (!RootTypes.ContainsKey(kind))
            throw new ArgumentException($"Unsupported trace query kind: {kind}", nameof(kind));

        options ??= new TraceGraphQueryOptions();
        Validate(options);
        var stopwatch = Stopwatch.StartNew();
        var limits = new TraceGraphQueryLimits(options.Depth, options.MaximumNodes, options.MaximumEdges);
        var state = new TraceGraphRepository().ReadCurrent(databasePath);
        var freshness = ReadFreshness(databasePath, options.ExpectedSourceCommit, state.Nodes.Count);
        var advisoryItemsOmitted = options.IncludeAdvisory
            ? 0
            : state.Nodes.Count(item => item.TrustTier == "T2") + state.Edges.Count(item => item.TrustTier == "T2");
        var nodes = state.Nodes
            .Where(item => options.IncludeAdvisory || item.TrustTier != "T2")
            .ToDictionary(item => item.NodeId, StringComparer.Ordinal);
        var edges = state.Edges
            .Where(item => options.IncludeAdvisory || item.TrustTier != "T2")
            .Where(item => nodes.ContainsKey(item.FromNodeId) && nodes.ContainsKey(item.ToNodeId))
            .OrderBy(item => item.EdgeId, StringComparer.Ordinal)
            .ToList();
        var diagnostics = new List<string>();
        if (advisoryItemsOmitted > 0)
            diagnostics.Add($"{advisoryItemsOmitted} T2 advisory graph item(s) were excluded; pass includeAdvisory to opt in.");

        var candidates = Resolve(nodes.Values, entity, RootTypes[kind]);
        if (candidates.Count == 0)
        {
            var unsupportedCandidates = Resolve(nodes.Values, entity, null);
            if (unsupportedCandidates.Count > 0)
            {
                var selected = unsupportedCandidates.Take(options.MaximumNodes)
                    .Select(item => ToQueryNode(item, 0)).ToList();
                var resolutionStatus = unsupportedCandidates.Count == 1 ? "unsupported" : "ambiguous";
                diagnostics.Add(unsupportedCandidates.Count == 1
                    ? $"Query kind {kind} does not support root type {unsupportedCandidates[0].NodeType}."
                    : $"The entity matches multiple nodes, but none has a root type supported by query kind {kind}.");
                return new TraceGraphQueryResult(
                    "trace_graph", kind, entity, resolutionStatus, false,
                    Authoritative(selected, []), selected.Any(item => item.TrustTier == "T2"), true,
                    limits, freshness, unsupportedCandidates.Count == 1 ? selected[0] : null,
                    unsupportedCandidates.Count == 1 ? [] : selected,
                    unsupportedCandidates.Count == 1 ? selected : [], [], [], [], diagnostics,
                    new TraceGraphQueryMetrics(unsupportedCandidates.Count == 1 ? 1 : 0, 0, 0, 0,
                        advisoryItemsOmitted, unsupportedCandidates.Count > options.MaximumNodes,
                        unsupportedCandidates.Count > options.MaximumNodes ? ["node_budget"] : [],
                        stopwatch.ElapsedMilliseconds));
            }
            if (!options.IncludeAdvisory && Resolve(state.Nodes, entity, RootTypes[kind]).Any(item => item.TrustTier == "T2"))
                diagnostics.Add("The entity exists only as T2 advisory data.");
            diagnostics.Add("No fallback was attempted. Use memory-search for text discovery or find-symbol for a structural symbol lookup.");
            return EmptyResult(kind, entity, "not_found", limits, freshness, diagnostics,
                advisoryItemsOmitted, stopwatch.ElapsedMilliseconds);
        }

        if (candidates.Count > 1)
        {
            diagnostics.Add("Entity resolution is ambiguous; use an exact nodeId or canonicalRef.");
            var partial = candidates.Count > options.MaximumNodes;
            var selected = candidates.Take(options.MaximumNodes).Select(item => ToQueryNode(item, 0)).ToList();
            return new TraceGraphQueryResult(
                "trace_graph", kind, entity, "ambiguous", false,
                Authoritative(selected, []), selected.Any(item => item.TrustTier == "T2"), true,
                limits, freshness, null, selected, [], [], [], [], diagnostics,
                new TraceGraphQueryMetrics(0, 0, 0, 0, advisoryItemsOmitted, partial,
                    partial ? ["node_budget"] : [], stopwatch.ElapsedMilliseconds));
        }

        var root = candidates[0];
        var traversal = Traverse(kind, root, nodes, edges, options);
        diagnostics.AddRange(traversal.Diagnostics);
        var status = traversal.Status;
        if (status == "ok" && freshness.Status == "stale")
        {
            status = "stale";
            diagnostics.Add("Trace graph source commits do not match the expected repository commit.");
        }
        else if (status == "ok" && traversal.Partial)
        {
            status = "partial";
        }

        stopwatch.Stop();
        var queryNodes = traversal.Nodes.Select(item => ToQueryNode(item.Node, item.Depth)).ToList();
        var queryEdges = traversal.Edges.Select(item => ToQueryEdge(item.Edge, item.Direction, item.Depth)).ToList();
        var currentEntities = traversal.CurrentEntities.Select(item => ToQueryNode(item, traversal.Depths[item.NodeId])).ToList();
        var authoritative = Authoritative(queryNodes, queryEdges);
        return new TraceGraphQueryResult(
            "trace_graph", kind, entity, status, false, authoritative,
            queryNodes.Any(item => item.TrustTier == "T2") || queryEdges.Any(item => item.TrustTier == "T2"),
            queryEdges.All(item => !string.IsNullOrWhiteSpace(item.EvidenceRef)),
            limits, freshness, ToQueryNode(root, 0), [], queryNodes, queryEdges, traversal.Paths,
            currentEntities, diagnostics,
            new TraceGraphQueryMetrics(queryNodes.Count, queryEdges.Count, traversal.Paths.Count,
                traversal.CyclesDetected, advisoryItemsOmitted, traversal.Partial,
                traversal.TruncationReasons, stopwatch.ElapsedMilliseconds));
    }

    private static TraversalResult Traverse(
        string kind,
        TraceNodeVersion root,
        IReadOnlyDictionary<string, TraceNodeVersion> nodes,
        IReadOnlyList<TraceEdgeVersion> edges,
        TraceGraphQueryOptions options)
    {
        var returnedNodes = new List<TraversedNode> { new(root, 0) };
        var returnedEdges = new List<TraversedEdge>();
        var paths = new List<TraceGraphEvidencePath>();
        var visitedNodes = new HashSet<string>(StringComparer.Ordinal) { root.NodeId };
        var visitedEdges = new HashSet<string>(StringComparer.Ordinal);
        var depths = new Dictionary<string, int>(StringComparer.Ordinal) { [root.NodeId] = 0 };
        var queue = new Queue<QueueItem>();
        queue.Enqueue(new QueueItem(root.NodeId, 0, [root.NodeId], [], [], null, IsAuthoritative(root)));
        var truncationReasons = new HashSet<string>(StringComparer.Ordinal);
        var diagnostics = new List<string>();
        var cyclesDetected = 0;

        while (queue.Count > 0)
        {
            var item = queue.Dequeue();
            var adjacent = Adjacent(kind, item.NodeId, edges);
            if (item.Depth >= options.Depth)
            {
                if (adjacent.Any(candidate => !visitedEdges.Contains(candidate.Edge.EdgeId)))
                    truncationReasons.Add("depth_budget");
                continue;
            }

            foreach (var candidate in adjacent)
            {
                if (visitedEdges.Contains(candidate.Edge.EdgeId))
                    continue;
                if (!nodes.TryGetValue(candidate.NeighborId, out var neighbor))
                    continue;
                if (returnedEdges.Count >= options.MaximumEdges)
                {
                    truncationReasons.Add("edge_budget");
                    continue;
                }
                if (!visitedNodes.Contains(neighbor.NodeId) && returnedNodes.Count >= options.MaximumNodes)
                {
                    truncationReasons.Add("node_budget");
                    continue;
                }

                visitedEdges.Add(candidate.Edge.EdgeId);
                var nextDepth = item.Depth + 1;
                returnedEdges.Add(new TraversedEdge(candidate.Edge, candidate.Direction, nextDepth));
                if (visitedNodes.Contains(neighbor.NodeId))
                {
                    if (!string.Equals(item.ParentEdgeId, candidate.Edge.EdgeId, StringComparison.Ordinal))
                        cyclesDetected++;
                    continue;
                }

                visitedNodes.Add(neighbor.NodeId);
                depths[neighbor.NodeId] = nextDepth;
                returnedNodes.Add(new TraversedNode(neighbor, nextDepth));
                var nodePath = item.NodeIds.Append(neighbor.NodeId).ToList();
                var edgePath = item.EdgeIds.Append(candidate.Edge.EdgeId).ToList();
                var evidencePath = item.EvidenceRefs.Append(candidate.Edge.EvidenceRef).ToList();
                paths.Add(new TraceGraphEvidencePath(neighbor.NodeId, nodePath, edgePath, evidencePath,
                    item.PathAuthoritative && IsAuthoritative(candidate.Edge) && IsAuthoritative(neighbor)));
                queue.Enqueue(new QueueItem(neighbor.NodeId, nextDepth, nodePath, edgePath, evidencePath,
                    candidate.Edge.EdgeId, item.PathAuthoritative && IsAuthoritative(candidate.Edge) && IsAuthoritative(neighbor)));
            }
        }

        var currentEntities = new List<TraceNodeVersion>();
        var status = "ok";
        if (kind == "current")
        {
            currentEntities = returnedNodes.Select(item => item.Node)
                .Where(node => !edges.Any(edge => edge.EdgeType == "supersedes" && edge.ToNodeId == node.NodeId))
                .OrderBy(item => item.CanonicalRef, StringComparer.Ordinal)
                .ToList();
            if (currentEntities.Count > 1)
            {
                status = "ambiguous";
                diagnostics.Add("Multiple current entities supersede the requested root; the decision lineage branches.");
            }
            else if (currentEntities.Count == 0 && truncationReasons.Count == 0)
            {
                status = "not_found";
                diagnostics.Add("No terminal current entity exists in the supersession lineage.");
            }
        }
        else if (kind == "evidence-for" && !returnedNodes.Any(item => item.Node.NodeType == "evidence"))
        {
            diagnostics.Add("No evidence node is reachable through verified_by edges within the configured limits.");
            if (truncationReasons.Count == 0)
                status = "not_found";
        }

        if (truncationReasons.Count > 0)
            diagnostics.Add($"Traversal stopped at configured {string.Join(", ", truncationReasons.OrderBy(item => item, StringComparer.Ordinal))}.");

        return new TraversalResult(returnedNodes, returnedEdges, paths, currentEntities, depths,
            status, truncationReasons.Count > 0, truncationReasons.OrderBy(item => item, StringComparer.Ordinal).ToList(),
            cyclesDetected, diagnostics);
    }

    private static IReadOnlyList<AdjacentEdge> Adjacent(
        string kind,
        string nodeId,
        IReadOnlyList<TraceEdgeVersion> edges)
    {
        var result = new List<AdjacentEdge>();
        foreach (var edge in edges)
        {
            if (kind == "current")
            {
                if (edge.EdgeType == "supersedes" && edge.ToNodeId == nodeId)
                    result.Add(new AdjacentEdge(edge, edge.FromNodeId, "incoming"));
                continue;
            }
            if (kind == "evidence-for")
            {
                if ((edge.EdgeType == "verified_by" || edge.EdgeType == "implements") && edge.FromNodeId == nodeId)
                    result.Add(new AdjacentEdge(edge, edge.ToNodeId, "outgoing"));
                continue;
            }

            if (edge.FromNodeId == nodeId)
                result.Add(new AdjacentEdge(edge, edge.ToNodeId, "outgoing"));
            else if (edge.ToNodeId == nodeId)
                result.Add(new AdjacentEdge(edge, edge.FromNodeId, "incoming"));
        }
        return result.OrderBy(item => item.Edge.EdgeId, StringComparer.Ordinal).ToList();
    }

    private static List<TraceNodeVersion> Resolve(
        IEnumerable<TraceNodeVersion> nodes,
        string query,
        IReadOnlySet<string>? allowedTypes)
    {
        var available = nodes.Where(item => allowedTypes is null || allowedTypes.Contains(item.NodeType)).ToList();
        var normalized = query.Trim().Replace('\\', '/');
        var exactId = available.Where(item => string.Equals(item.NodeId, normalized, StringComparison.Ordinal)).ToList();
        if (exactId.Count > 0) return Order(exactId);
        var exactRef = available.Where(item => string.Equals(item.CanonicalRef, normalized, StringComparison.OrdinalIgnoreCase)).ToList();
        if (exactRef.Count > 0) return Order(exactRef);
        var exactTitle = available.Where(item => string.Equals(item.Title, normalized, StringComparison.OrdinalIgnoreCase)).ToList();
        if (exactTitle.Count > 0) return Order(exactTitle);
        var simple = available.Where(item => SimpleName(item).Equals(normalized, StringComparison.OrdinalIgnoreCase)).ToList();
        return Order(simple);
    }

    private static List<TraceNodeVersion> Order(IEnumerable<TraceNodeVersion> nodes)
        => nodes.OrderBy(item => item.NodeType, StringComparer.Ordinal)
            .ThenBy(item => item.CanonicalRef, StringComparer.Ordinal)
            .ThenBy(item => item.NodeId, StringComparer.Ordinal)
            .ToList();

    private static string SimpleName(TraceNodeVersion node)
    {
        if (node.NodeType == "file")
            return node.CanonicalRef.Split('/', StringSplitOptions.RemoveEmptyEntries).LastOrDefault() ?? node.CanonicalRef;
        if (node.NodeType != "symbol")
            return node.CanonicalRef;
        var value = node.CanonicalRef.Replace("::", ".", StringComparison.Ordinal);
        var index = value.LastIndexOf('.');
        return index >= 0 ? value[(index + 1)..] : value;
    }

    private static TraceGraphFreshness ReadFreshness(string databasePath, string? expectedCommit, int nodeCount)
    {
        var sources = new List<TraceGraphSourceFreshness>();
        using var connection = new SqliteConnection($"Data Source={databasePath}");
        connection.Open();
        using var command = connection.CreateCommand();
        command.CommandText = @"
SELECT runs.source_namespace, runs.source_commit, runs.completed_at
FROM trace_ingest_runs runs
JOIN (
    SELECT source_namespace, MAX(id) AS latest_id
    FROM trace_ingest_runs
    GROUP BY source_namespace
) latest ON latest.latest_id = runs.id
ORDER BY runs.source_namespace;";
        using var reader = command.ExecuteReader();
        while (reader.Read())
        {
            var commit = reader.GetString(1);
            sources.Add(new TraceGraphSourceFreshness(
                reader.GetString(0), commit, reader.GetString(2),
                string.IsNullOrWhiteSpace(expectedCommit)
                    ? null
                    : string.Equals(commit, expectedCommit, StringComparison.Ordinal)));
        }

        var staleSources = sources.Where(item => item.MatchesExpectedCommit == false)
            .Select(item => item.SourceNamespace).ToList();
        var status = string.IsNullOrWhiteSpace(expectedCommit)
            ? "unchecked"
            : sources.Count == 0
                ? nodeCount == 0 ? "empty" : "stale"
                : staleSources.Count == 0 ? "fresh" : "stale";
        return new TraceGraphFreshness(status, expectedCommit, staleSources, sources);
    }

    private static void Validate(TraceGraphQueryOptions options)
    {
        if (options.Depth is < 1 or > MaximumAllowedDepth)
            throw new ArgumentOutOfRangeException(nameof(options), $"Depth must be between 1 and {MaximumAllowedDepth}.");
        if (options.MaximumNodes is < 1 or > MaximumAllowedNodes)
            throw new ArgumentOutOfRangeException(nameof(options), $"MaximumNodes must be between 1 and {MaximumAllowedNodes}.");
        if (options.MaximumEdges is < 1 or > MaximumAllowedEdges)
            throw new ArgumentOutOfRangeException(nameof(options), $"MaximumEdges must be between 1 and {MaximumAllowedEdges}.");
    }

    private static TraceGraphQueryResult EmptyResult(
        string kind,
        string entity,
        string status,
        TraceGraphQueryLimits limits,
        TraceGraphFreshness freshness,
        IReadOnlyList<string> diagnostics,
        int advisoryItemsOmitted,
        long elapsed)
        => new("trace_graph", kind, entity, status, false, false, false, true, limits, freshness,
            null, [], [], [], [], [], diagnostics,
            new TraceGraphQueryMetrics(0, 0, 0, 0, advisoryItemsOmitted, false, [], elapsed));

    private static TraceGraphQueryNode ToQueryNode(TraceNodeVersion item, int depth)
        => new(item.NodeId, item.NodeType, item.NodeNamespace, item.CanonicalRef, item.Title,
            item.SourceNamespace, item.SourceHash, item.SourceCommit, item.Origin, item.TrustTier,
            item.Authority, item.ValidFrom, depth);

    private static TraceGraphQueryEdge ToQueryEdge(TraceEdgeVersion item, string direction, int depth)
        => new(item.EdgeId, item.FromNodeId, item.ToNodeId, item.EdgeType, direction, item.Origin,
            item.Confidence, item.TrustTier, item.EvidenceRef, item.SourceNamespace, item.SourceHash,
            item.SourceCommit, item.ValidFrom, depth);

    private static bool Authoritative(
        IReadOnlyList<TraceGraphQueryNode> nodes,
        IReadOnlyList<TraceGraphQueryEdge> edges)
        => nodes.Count > 0
           && nodes.All(item => item.TrustTier != "T2" && item.Authority is not ("advisory" or "proposed"))
           && edges.All(item => item.TrustTier != "T2");

    private static bool IsAuthoritative(TraceNodeVersion node)
        => node.TrustTier != "T2" && node.Authority is not ("advisory" or "proposed");

    private static bool IsAuthoritative(TraceEdgeVersion edge) => edge.TrustTier != "T2";

    private sealed record TraversedNode(TraceNodeVersion Node, int Depth);
    private sealed record TraversedEdge(TraceEdgeVersion Edge, string Direction, int Depth);
    private sealed record AdjacentEdge(TraceEdgeVersion Edge, string NeighborId, string Direction);
    private sealed record QueueItem(
        string NodeId,
        int Depth,
        IReadOnlyList<string> NodeIds,
        IReadOnlyList<string> EdgeIds,
        IReadOnlyList<string> EvidenceRefs,
        string? ParentEdgeId,
        bool PathAuthoritative = true);
    private sealed record TraversalResult(
        IReadOnlyList<TraversedNode> Nodes,
        IReadOnlyList<TraversedEdge> Edges,
        IReadOnlyList<TraceGraphEvidencePath> Paths,
        IReadOnlyList<TraceNodeVersion> CurrentEntities,
        IReadOnlyDictionary<string, int> Depths,
        string Status,
        bool Partial,
        IReadOnlyList<string> TruncationReasons,
        int CyclesDetected,
        IReadOnlyList<string> Diagnostics);
}
