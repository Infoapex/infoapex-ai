using System.Text.Json;
using AiCodeControl.CodeIndexer.Services;
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
