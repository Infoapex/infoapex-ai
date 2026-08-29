namespace AiCodeControl.Core.Models;

public sealed record TraceIngestDocument(
    string Kind,
    string FilePath,
    string CanonicalRef);

public sealed record TraceGraphIngestRequest(
    string RepositoryRoot,
    string CodegraphDatabasePath,
    string SourceCommit,
    DateTimeOffset EffectiveAt,
    IReadOnlyList<TraceIngestDocument> Documents,
    bool IncludeCodeIndex = true);

public sealed record TraceIngestDiagnostic(
    string Code,
    string Severity,
    string SourceRef,
    string Message,
    IReadOnlyList<string>? Candidates = null);

public sealed record TraceGraphIngestResult(
    TraceGraphSnapshot Snapshot,
    IReadOnlyList<TraceIngestDiagnostic> Diagnostics,
    int DocumentsRead,
    int DocumentsSkipped,
    int NodesProduced,
    int EdgesProduced);

