using System.Text.Json;
using AiCodeControl.CodeIndexer.Services;
using AiCodeControl.Core.Models;
using AiCodeControl.Core.Services;
using Xunit;

namespace AiCodeControl.Tests;

public sealed class ObsidianExportTests : IDisposable
{
    private readonly string _root;

    public ObsidianExportTests()
    {
        _root = Path.Combine(Path.GetTempPath(), "acc-obsidian-tests", Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(_root);
    }

    [Fact]
    public void Export_WritesMarkdownCanvasAndProvenance()
    {
        Write("src/Orders.cs", "namespace Demo; public sealed class OrderService { public void PlaceOrder() { } }");
        Write("web/cart.ts", "export function addToCart() { return 1; }");
        var database = new DatabaseInitializer().InitializeCodegraph(_root);
        new CodeIndexerService().Index(_root, ".", database, fullRebuild: true);

        var result = new ObsidianExportService().Export(new ObsidianExportOptions
        {
            RepositoryRoot = _root,
            DatabasePath = database,
            IncludeSymbols = true,
            MaxSymbols = 20
        });

        var output = Path.Combine(_root, "docs", "code-map", "generated");
        Assert.Equal("ok", result.Status);
        Assert.Equal(output, result.OutputPath);
        Assert.Equal(2, result.Files);
        Assert.True(result.Symbols >= 2);
        Assert.True(File.Exists(Path.Combine(output, "index.md")));
        Assert.True(File.Exists(Path.Combine(output, "canvases", "code-map.canvas")));
        Assert.True(File.Exists(Path.Combine(output, ".export-manifest.json")));
        Assert.Contains("source_of_truth", File.ReadAllText(Path.Combine(output, "index.md")));
        Assert.Contains("```mermaid", File.ReadAllText(Path.Combine(output, "index.md")));

        using var canvas = JsonDocument.Parse(File.ReadAllText(Path.Combine(output, "canvases", "code-map.canvas")));
        Assert.True(canvas.RootElement.GetProperty("nodes").GetArrayLength() >= 2);
        Assert.True(canvas.RootElement.GetProperty("edges").GetArrayLength() >= 1);
    }

    [Fact]
    public void Export_RespectsScopeAndRejectsTraversal()
    {
        Write("src/A.cs", "namespace Demo; public class A { }");
        Write("web/B.ts", "export function b() { return 1; }");
        var database = new DatabaseInitializer().InitializeCodegraph(_root);
        new CodeIndexerService().Index(_root, ".", database, fullRebuild: true);

        var service = new ObsidianExportService();
        var scoped = service.Export(new ObsidianExportOptions
        {
            RepositoryRoot = _root,
            DatabasePath = database,
            ScopePath = "src",
            OutputPath = "vault"
        });

        Assert.Equal(1, scoped.Files);
        Assert.True(File.Exists(Path.Combine(_root, "vault", "files", "src-a-cs.md")));
        Assert.False(File.Exists(Path.Combine(_root, "vault", "files", "web-b-ts.md")));
        Assert.Throws<InvalidOperationException>(() => service.Export(new ObsidianExportOptions
        {
            RepositoryRoot = _root,
            DatabasePath = database,
            ScopePath = "../outside",
            OutputPath = "vault-traversal"
        }));
    }

    [Fact]
    public void Export_WritesTypedTraceProjectionWithExplicitRelationsAndCodeLinks()
    {
        Write("src/Orders.cs", "namespace Demo; public sealed class OrderService { public void PlaceOrder() { } }");
        var database = new DatabaseInitializer().InitializeCodegraph(_root);
        new CodeIndexerService().Index(_root, ".", database, fullRebuild: true);
        var snapshot = TraceSnapshot(includeOld: true, includeAdvisory: true);
        var state = new TraceGraphRepository().Rebuild(database, [snapshot]);

        var result = new ObsidianExportService().Export(new ObsidianExportOptions
        {
            RepositoryRoot = _root,
            DatabasePath = database
        });

        var output = Path.Combine(_root, "docs", "code-map", "generated");
        Assert.Equal(state.Digest, result.TraceGraphDigest);
        Assert.Equal(5, result.TraceNodes);
        Assert.True(File.Exists(Path.Combine(output, "trace-index.md")));
        Assert.True(File.Exists(Path.Combine(output, "canvases", "trace-map.canvas")));
        Assert.True(File.Exists(Path.Combine(output, ".trace-projection-manifest.json")));
        var traceText = string.Join("\n", Directory.GetFiles(Path.Combine(output, "trace"), "*.md", SearchOption.AllDirectories)
            .Select(File.ReadAllText));
        Assert.Contains("`implements`", traceText);
        Assert.Contains("`verified_by`", traceText);
        Assert.Contains("`references`", traceText);
        Assert.Contains("[[files/src-orders-cs|src/Orders.cs]]", traceText);
        Assert.DoesNotContain("ADR old", traceText);
        Assert.DoesNotContain("Advisory task", traceText);

        using var manifest = JsonDocument.Parse(File.ReadAllText(Path.Combine(output, ".trace-projection-manifest.json")));
        Assert.Equal("1.0", manifest.RootElement.GetProperty("schemaVersion").GetString());
        Assert.Equal(state.Digest, manifest.RootElement.GetProperty("graphDigest").GetString());
        Assert.NotEmpty(manifest.RootElement.GetProperty("sourceHashes").EnumerateArray());
    }

    [Fact]
    public void Export_OptionalFiltersIncludeAdvisoryAndSuperseded()
    {
        Write("src/Orders.cs", "namespace Demo; public sealed class OrderService { }");
        var database = new DatabaseInitializer().InitializeCodegraph(_root);
        new CodeIndexerService().Index(_root, ".", database, fullRebuild: true);
        new TraceGraphRepository().Rebuild(database, [TraceSnapshot(includeOld: true, includeAdvisory: true)]);

        var result = new ObsidianExportService().Export(new ObsidianExportOptions
        {
            RepositoryRoot = _root,
            DatabasePath = database,
            IncludeAdvisory = true,
            IncludeSuperseded = true
        });

        var output = Path.Combine(_root, "docs", "code-map", "generated", "trace");
        var text = string.Join("\n", Directory.GetFiles(output, "*.md", SearchOption.AllDirectories).Select(File.ReadAllText));
        Assert.Equal(7, result.TraceNodes);
        Assert.Contains("ADR old", text);
        Assert.Contains("Advisory task", text);
        Assert.Contains("lifecycle: \"superseded\"", text);
        Assert.Contains("trust_tier: \"T2\"", text);
    }

    [Fact]
    public void Export_AtomicSwapRemovesStaleTraceNotes()
    {
        Write("src/Orders.cs", "namespace Demo; public sealed class OrderService { }");
        var database = new DatabaseInitializer().InitializeCodegraph(_root);
        new CodeIndexerService().Index(_root, ".", database, fullRebuild: true);
        var repository = new TraceGraphRepository();
        repository.Rebuild(database, [TraceSnapshot(includeOld: true, includeAdvisory: true)]);
        var service = new ObsidianExportService();
        service.Export(new ObsidianExportOptions
        {
            RepositoryRoot = _root,
            DatabasePath = database,
            IncludeAdvisory = true,
            IncludeSuperseded = true
        });
        var output = Path.Combine(_root, "docs", "code-map", "generated");
        var firstFiles = Directory.GetFiles(Path.Combine(output, "trace"), "*.md", SearchOption.AllDirectories);
        Assert.Equal(7, firstFiles.Length);

        repository.Rebuild(database, [TraceSnapshot(includeOld: false, includeAdvisory: false)]);
        service.Export(new ObsidianExportOptions { RepositoryRoot = _root, DatabasePath = database });

        var secondFiles = Directory.GetFiles(Path.Combine(output, "trace"), "*.md", SearchOption.AllDirectories);
        Assert.Equal(5, secondFiles.Length);
        Assert.Empty(Directory.GetDirectories(Path.GetDirectoryName(output)!, "generated.staging-*"));
        Assert.Empty(Directory.GetDirectories(Path.GetDirectoryName(output)!, "generated.backup-*"));
    }

    [Fact]
    public void Export_ManifestPassesThenDetectsGraphDrift()
    {
        Write("src/Orders.cs", "namespace Demo; public sealed class OrderService { }");
        var database = new DatabaseInitializer().InitializeCodegraph(_root);
        new CodeIndexerService().Index(_root, ".", database, fullRebuild: true);
        var repository = new TraceGraphRepository();
        repository.Rebuild(database, [TraceSnapshot(includeOld: false, includeAdvisory: false)]);
        new ObsidianExportService().Export(new ObsidianExportOptions { RepositoryRoot = _root, DatabasePath = database });
        var manifestPath = "docs/code-map/generated/.trace-projection-manifest.json";
        var service = new TraceGraphDriftService();
        var before = service.Check(new TraceGraphDriftOptions(_root, database,
            ProjectionManifestPath: manifestPath, MinimumCoveragePercent: 100));
        Assert.Equal("pass", before.Projection.Status);

        repository.Rebuild(database, [TraceSnapshot(includeOld: true, includeAdvisory: false)]);
        var after = service.Check(new TraceGraphDriftOptions(_root, database,
            ProjectionManifestPath: manifestPath, MinimumCoveragePercent: 100));
        Assert.Equal("fail", after.Projection.Status);
        Assert.Contains(after.Findings, finding => finding.Code == "PROJECTION_DIGEST_MISMATCH");
    }

    private static TraceGraphSnapshot TraceSnapshot(bool includeOld, bool includeAdvisory)
    {
        const string hash = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
        var adr = NodeId("adr", "ADR-2");
        var old = NodeId("adr", "ADR-1");
        var task = NodeId("task", "TASK-1");
        var criterion = NodeId("criterion", "CRIT-1");
        var gate = NodeId("gate", "GATE-1");
        var evidence = NodeId("evidence", "EVIDENCE-1");
        var file = NodeId("file", "src/Orders.cs");
        var nodes = new List<TraceNodeInput>
        {
            Node("adr", "ADR-2", "ADR current"),
            Node("task", "TASK-1", "Build task"),
            Node("criterion", "CRIT-1", "Acceptance criterion"),
            Node("gate", "GATE-1", "Validation gate"),
            Node("evidence", "EVIDENCE-1", "Test evidence", "runtime-evidence", "T0"),
            Node("file", "src/Orders.cs", "Orders source", "ast", "T0")
        };
        var edges = new List<TraceEdgeInput>
        {
            Edge(task, criterion, "implements", "task.json"),
            Edge(criterion, gate, "verified_by", "gate.json"),
            Edge(gate, evidence, "verified_by", "evidence.json"),
            Edge(adr, file, "references", "ADR-2.md")
        };
        if (includeOld)
        {
            nodes.Add(Node("adr", "ADR-1", "ADR old"));
            edges.Add(Edge(adr, old, "supersedes", "ADR-2.md"));
        }
        if (includeAdvisory)
            nodes.Add(new TraceNodeInput("task", "task", "TASK-T2", "Advisory task", hash, "model", "T2", Authority: "advisory"));
        return new TraceGraphSnapshot("projection-test", "commit-a", DateTimeOffset.UtcNow, nodes, edges);

        static TraceNodeInput Node(string type, string canonicalRef, string title,
            string origin = "json-contract", string tier = "T0")
            => new(type, type, canonicalRef, title, hash, origin, tier);
        static TraceEdgeInput Edge(string from, string to, string type, string evidenceRef)
            => new(from, to, type, "runtime-evidence", "deterministic", "T0", evidenceRef, hash);
    }

    private static string NodeId(string type, string canonicalRef)
        => TraceGraphRepository.ComputeNodeId(type, canonicalRef);

    private void Write(string relativePath, string content)
    {
        var fullPath = Path.Combine(_root, relativePath.Replace('/', Path.DirectorySeparatorChar));
        Directory.CreateDirectory(Path.GetDirectoryName(fullPath)!);
        File.WriteAllText(fullPath, content);
    }

    public void Dispose()
    {
        Microsoft.Data.Sqlite.SqliteConnection.ClearAllPools();
        try { Directory.Delete(_root, recursive: true); } catch { }
    }
}
