using System.Text.Json;
using AiCodeControl.Core.Services;
using Xunit;

namespace AiCodeControl.Tests;

public sealed class TraceGraphIngestManifestServiceTests : IDisposable
{
    private readonly string _root = Path.Combine(Path.GetTempPath(), "acc-trace-manifest-" + Guid.NewGuid().ToString("N"));
    private readonly TraceGraphIngestManifestService _service = new();

    [Fact]
    public void Load_ResolvesStrictDeclaredDocumentsAndDefaultsCodeIndexOn()
    {
        Write("docs/ADR-0001.md", "# ADR-0001\nStatus: Accepted\n");
        Write("trace.json", """
        {"schemaVersion":"1.0","documents":[
          {"kind":"adr","path":"docs/ADR-0001.md","canonicalRef":"docs/ADR-0001.md"}
        ]}
        """);

        var manifest = _service.Load(_root, "trace.json");
        var request = _service.CreateRequest(_root, Path.Combine(_root, "graph.sqlite"),
            "trace.json", "commit-1", DateTimeOffset.Parse("2026-08-29T00:00:00Z"));

        Assert.True(manifest.IncludeCodeIndex);
        Assert.Single(manifest.Documents);
        Assert.Equal(Path.Combine(_root, "docs", "ADR-0001.md"), Assert.Single(request.Documents).FilePath);
    }

    [Fact]
    public void Load_RejectsUnknownPropertiesAndDuplicateIdentity()
    {
        Write("docs/ADR.md", "# ADR-0001");
        Write("unknown.json", """
        {"schemaVersion":"1.0","unknown":true,"documents":[
          {"kind":"adr","path":"docs/ADR.md","canonicalRef":"ADR.md"}
        ]}
        """);
        Write("duplicate.json", """
        {"schemaVersion":"1.0","documents":[
          {"kind":"adr","path":"docs/ADR.md","canonicalRef":"ADR.md"},
          {"kind":"adr","path":"docs/ADR.md","canonicalRef":"ADR.md"}
        ]}
        """);

        Assert.Throws<JsonException>(() => _service.Load(_root, "unknown.json"));
        Assert.Throws<JsonException>(() => _service.Load(_root, "duplicate.json"));
    }

    [Fact]
    public void Load_RejectsManifestDocumentAndCanonicalTraversal()
    {
        var outside = Path.Combine(Path.GetDirectoryName(_root)!, "outside.json");
        Assert.Throws<InvalidOperationException>(() => _service.Load(_root, outside));
        Write("bad-path.json", """
        {"schemaVersion":"1.0","documents":[
          {"kind":"adr","path":"../outside.md","canonicalRef":"ADR.md"}
        ]}
        """);
        Write("bad-ref.json", """
        {"schemaVersion":"1.0","documents":[
          {"kind":"adr","path":"docs/ADR.md","canonicalRef":"../ADR.md"}
        ]}
        """);
        Assert.Throws<InvalidOperationException>(() => _service.Load(_root, "bad-path.json"));
        Assert.Throws<JsonException>(() => _service.Load(_root, "bad-ref.json"));
    }

    [Fact]
    public void DeclaredManifest_BuildsAndRebuildsTraceGraphEndToEnd()
    {
        Write("docs/ADR-0001.md", "# ADR-0001\nStatus: Accepted\n");
        Write("trace.json", """
        {"schemaVersion":"1.0","includeCodeIndex":false,"documents":[
          {"kind":"adr","path":"docs/ADR-0001.md","canonicalRef":"docs/ADR-0001.md"}
        ]}
        """);
        var database = new DatabaseInitializer().InitializeCodegraph(_root);
        var request = _service.CreateRequest(_root, database, "trace.json", "commit-1",
            DateTimeOffset.Parse("2026-08-29T00:00:00Z"));

        var (ingest, state) = new TraceGraphIngestService().Rebuild(request, new TraceGraphRepository());

        Assert.DoesNotContain(ingest.Diagnostics, item => item.Severity == "error");
        Assert.Contains(state.Nodes, node => node.NodeType == "adr" && node.CanonicalRef == "ADR-0001");
        Assert.NotEmpty(state.Digest);
    }

    private void Write(string relative, string content)
    {
        var path = Path.Combine(_root, relative.Replace('/', Path.DirectorySeparatorChar));
        Directory.CreateDirectory(Path.GetDirectoryName(path)!);
        File.WriteAllText(path, content);
    }

    public void Dispose()
    {
        Microsoft.Data.Sqlite.SqliteConnection.ClearAllPools();
        try { Directory.Delete(_root, recursive: true); } catch { }
    }
}
