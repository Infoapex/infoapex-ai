namespace AiCodeControl.Core.Models;

public sealed record TraceNodeInput(
    string NodeType,
    string NodeNamespace,
    string CanonicalRef,
    string Title,
    string SourceHash,
    string Origin,
    string TrustTier,
    string PropertiesJson = "{}",
    string Authority = "canonical");

public sealed record TraceEdgeInput(
    string FromNodeId,
    string ToNodeId,
    string EdgeType,
    string Origin,
    string Confidence,
    string TrustTier,
    string EvidenceRef,
    string SourceHash,
    string PropertiesJson = "{}");

public sealed record TraceGraphSnapshot(
    string SourceNamespace,
    string SourceCommit,
    DateTimeOffset EffectiveAt,
    IReadOnlyList<TraceNodeInput> Nodes,
    IReadOnlyList<TraceEdgeInput> Edges);

public sealed record TraceNodeVersion(
    string NodeId,
    string NodeType,
    string NodeNamespace,
    string CanonicalRef,
    string Title,
    string SourceNamespace,
    string SourceHash,
    string SourceCommit,
    string Origin,
    string TrustTier,
    string Authority,
    DateTimeOffset ValidFrom,
    DateTimeOffset? ValidTo,
    string PropertiesJson);

public sealed record TraceEdgeVersion(
    string EdgeId,
    string FromNodeId,
    string ToNodeId,
    string EdgeType,
    string Origin,
    string Confidence,
    string TrustTier,
    string EvidenceRef,
    string SourceNamespace,
    string SourceHash,
    string SourceCommit,
    DateTimeOffset ValidFrom,
    DateTimeOffset? ValidTo,
    string PropertiesJson);

public sealed record TraceGraphState(
    IReadOnlyList<TraceNodeVersion> Nodes,
    IReadOnlyList<TraceEdgeVersion> Edges,
    string Digest);

public sealed record TraceGraphWriteResult(
    string SourceNamespace,
    string SourceCommit,
    int NodesInserted,
    int NodesExpired,
    int EdgesInserted,
    int EdgesExpired,
    string CurrentDigest);
