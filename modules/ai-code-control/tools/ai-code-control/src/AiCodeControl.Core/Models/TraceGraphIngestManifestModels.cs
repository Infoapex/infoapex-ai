namespace AiCodeControl.Core.Models;

public sealed record TraceGraphIngestManifest(
    string SchemaVersion,
    bool IncludeCodeIndex,
    IReadOnlyList<TraceGraphIngestManifestDocument> Documents);

public sealed record TraceGraphIngestManifestDocument(
    string Kind,
    string Path,
    string CanonicalRef);
