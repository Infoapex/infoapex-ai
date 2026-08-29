using System.Text.Json.Serialization;

namespace AiCodeControl.Core.Models;

public sealed record TraceGraphQueryOptions(
    [property: JsonPropertyName("depth")] int Depth = 3,
    [property: JsonPropertyName("maximumNodes")] int MaximumNodes = 50,
    [property: JsonPropertyName("maximumEdges")] int MaximumEdges = 100,
    [property: JsonPropertyName("includeAdvisory")] bool IncludeAdvisory = false,
    [property: JsonPropertyName("expectedSourceCommit")] string? ExpectedSourceCommit = null);

public sealed record TraceGraphQueryResult(
    [property: JsonPropertyName("route")] string Route,
    [property: JsonPropertyName("kind")] string Kind,
    [property: JsonPropertyName("query")] string Query,
    [property: JsonPropertyName("status")] string Status,
    [property: JsonPropertyName("fallbackUsed")] bool FallbackUsed,
    [property: JsonPropertyName("authoritative")] bool Authoritative,
    [property: JsonPropertyName("advisory")] bool Advisory,
    [property: JsonPropertyName("evidenceComplete")] bool EvidenceComplete,
    [property: JsonPropertyName("limits")] TraceGraphQueryLimits Limits,
    [property: JsonPropertyName("freshness")] TraceGraphFreshness Freshness,
    [property: JsonPropertyName("root")] TraceGraphQueryNode? Root,
    [property: JsonPropertyName("candidates")] IReadOnlyList<TraceGraphQueryNode> Candidates,
    [property: JsonPropertyName("nodes")] IReadOnlyList<TraceGraphQueryNode> Nodes,
    [property: JsonPropertyName("edges")] IReadOnlyList<TraceGraphQueryEdge> Edges,
    [property: JsonPropertyName("paths")] IReadOnlyList<TraceGraphEvidencePath> Paths,
    [property: JsonPropertyName("currentEntities")] IReadOnlyList<TraceGraphQueryNode> CurrentEntities,
    [property: JsonPropertyName("diagnostics")] IReadOnlyList<string> Diagnostics,
    [property: JsonPropertyName("metrics")] TraceGraphQueryMetrics Metrics);

public sealed record TraceGraphQueryLimits(
    [property: JsonPropertyName("depth")] int Depth,
    [property: JsonPropertyName("maximumNodes")] int MaximumNodes,
    [property: JsonPropertyName("maximumEdges")] int MaximumEdges);

public sealed record TraceGraphQueryNode(
    [property: JsonPropertyName("nodeId")] string NodeId,
    [property: JsonPropertyName("nodeType")] string NodeType,
    [property: JsonPropertyName("nodeNamespace")] string NodeNamespace,
    [property: JsonPropertyName("canonicalRef")] string CanonicalRef,
    [property: JsonPropertyName("title")] string Title,
    [property: JsonPropertyName("sourceNamespace")] string SourceNamespace,
    [property: JsonPropertyName("sourceHash")] string SourceHash,
    [property: JsonPropertyName("sourceCommit")] string SourceCommit,
    [property: JsonPropertyName("origin")] string Origin,
    [property: JsonPropertyName("trustTier")] string TrustTier,
    [property: JsonPropertyName("authority")] string Authority,
    [property: JsonPropertyName("validFrom")] DateTimeOffset ValidFrom,
    [property: JsonPropertyName("depth")] int Depth);

public sealed record TraceGraphQueryEdge(
    [property: JsonPropertyName("edgeId")] string EdgeId,
    [property: JsonPropertyName("fromNodeId")] string FromNodeId,
    [property: JsonPropertyName("toNodeId")] string ToNodeId,
    [property: JsonPropertyName("edgeType")] string EdgeType,
    [property: JsonPropertyName("traversalDirection")] string TraversalDirection,
    [property: JsonPropertyName("origin")] string Origin,
    [property: JsonPropertyName("confidence")] string Confidence,
    [property: JsonPropertyName("trustTier")] string TrustTier,
    [property: JsonPropertyName("evidenceRef")] string EvidenceRef,
    [property: JsonPropertyName("sourceNamespace")] string SourceNamespace,
    [property: JsonPropertyName("sourceHash")] string SourceHash,
    [property: JsonPropertyName("sourceCommit")] string SourceCommit,
    [property: JsonPropertyName("validFrom")] DateTimeOffset ValidFrom,
    [property: JsonPropertyName("depth")] int Depth);

public sealed record TraceGraphEvidencePath(
    [property: JsonPropertyName("toNodeId")] string ToNodeId,
    [property: JsonPropertyName("nodeIds")] IReadOnlyList<string> NodeIds,
    [property: JsonPropertyName("edgeIds")] IReadOnlyList<string> EdgeIds,
    [property: JsonPropertyName("evidenceRefs")] IReadOnlyList<string> EvidenceRefs,
    [property: JsonPropertyName("authoritative")] bool Authoritative);

public sealed record TraceGraphFreshness(
    [property: JsonPropertyName("status")] string Status,
    [property: JsonPropertyName("expectedSourceCommit")] string? ExpectedSourceCommit,
    [property: JsonPropertyName("staleSources")] IReadOnlyList<string> StaleSources,
    [property: JsonPropertyName("sources")] IReadOnlyList<TraceGraphSourceFreshness> Sources);

public sealed record TraceGraphSourceFreshness(
    [property: JsonPropertyName("sourceNamespace")] string SourceNamespace,
    [property: JsonPropertyName("sourceCommit")] string SourceCommit,
    [property: JsonPropertyName("completedAt")] string CompletedAt,
    [property: JsonPropertyName("matchesExpectedCommit")] bool? MatchesExpectedCommit);

public sealed record TraceGraphQueryMetrics(
    [property: JsonPropertyName("nodesReturned")] int NodesReturned,
    [property: JsonPropertyName("edgesReturned")] int EdgesReturned,
    [property: JsonPropertyName("pathsReturned")] int PathsReturned,
    [property: JsonPropertyName("cyclesDetected")] int CyclesDetected,
    [property: JsonPropertyName("advisoryItemsOmitted")] int AdvisoryItemsOmitted,
    [property: JsonPropertyName("partial")] bool Partial,
    [property: JsonPropertyName("truncationReasons")] IReadOnlyList<string> TruncationReasons,
    [property: JsonPropertyName("elapsedMilliseconds")] long ElapsedMilliseconds);
