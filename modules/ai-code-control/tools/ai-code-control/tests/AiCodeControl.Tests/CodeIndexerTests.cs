using System.Text.Json;
using AiCodeControl.CodeIndexer.Services;
using AiCodeControl.Core.Services;
using Microsoft.Data.Sqlite;
using Xunit;

namespace AiCodeControl.Tests;

public sealed class CodeIndexerTests : IDisposable
{
    private readonly string _root;
    private readonly string _database;

    public CodeIndexerTests()
    {
        _root = Path.Combine(Path.GetTempPath(), "acc-code-index-tests", Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(_root);
        _database = new DatabaseInitializer().InitializeCodegraph(_root);
    }

    [Fact]
    public void Index_ParsesSupportedLanguages_AndSkipsUnchangedFiles()
    {
        Write("src/Orders.cs", """
namespace Example.Orders;
public sealed class OrderService
{
    public void PlaceOrder() { Charge(); }
    private void Charge() { }
}
""");
        Write("web/cart.ts", """
export function addToCart() { calculateTotal(); }
const calculateTotal = () => 42;
""");
        Write("db/001.sql", """
CREATE TABLE commerce.orders (id uuid PRIMARY KEY);
CREATE VIEW commerce.order_view AS SELECT id FROM commerce.orders;
""");

        var service = new CodeIndexerService();
        var first = service.Index(_root, ".", _database);
        var second = service.Index(_root, ".", _database);

        Assert.Equal(3, first.FilesIndexed);
        Assert.True(first.SymbolsIndexed >= 6);
        Assert.Equal(0, second.FilesIndexed);
        Assert.Equal(3, second.FilesSkipped);

        var symbols = JsonSerializer.Serialize(new SymbolQueryService().FindSymbol(_database, "OrderService"));
        Assert.Contains("Example.Orders.OrderService", symbols);
        Assert.Contains("commerce.orders", JsonSerializer.Serialize(new SymbolQueryService().FindSymbol(_database, "orders")));
    }

    [Fact]
    public void Index_ReindexesChangedFile_AndPrunesDeletedFile()
    {
        Write("src/A.cs", "namespace Demo; public class A { public void One() {} }");
        Write("src/B.cs", "namespace Demo; public class B { public void Two() { One(); } }");
        var service = new CodeIndexerService();
        _ = service.Index(_root, ".", _database);

        Write("src/A.cs", "namespace Demo; public class A { public void One() {} public void Three() {} }");
        File.Delete(Path.Combine(_root, "src", "B.cs"));
        var result = service.Index(_root, ".", _database);

        Assert.Equal(1, result.FilesIndexed);
        Assert.Equal(1, result.FilesPruned);
        Assert.Contains("\"count\":0", JsonSerializer.Serialize(new SymbolQueryService().FindSymbol(_database, "Demo.B")));
        Assert.Contains("Three", JsonSerializer.Serialize(new SymbolQueryService().FindSymbol(_database, "Three")));
    }

    [Fact]
    public void ImpactAnalysis_ReportsAmbiguousSimpleNames()
    {
        Write("src/A.cs", "namespace One; public class A { public void Run() {} }");
        Write("src/B.cs", "namespace Two; public class B { public void Run() {} }");
        new CodeIndexerService().Index(_root, ".", _database);

        var result = JsonSerializer.Serialize(new SymbolQueryService().ImpactAnalysis(_database, "Run"));

        Assert.Contains("ambiguous", result);
        Assert.Contains("One.A.Run", result);
        Assert.Contains("Two.B.Run", result);
    }

    [Fact]
    public void FullRebuild_IsLimitedToRequestedScope()
    {
        Write("backend/A.cs", "namespace Demo; public class A { }");
        Write("frontend/a.ts", "export function keepMe() { return 1; }");
        var service = new CodeIndexerService();
        _ = service.Index(_root, ".", _database);

        var result = service.Index(_root, "backend", _database, fullRebuild: true);

        Assert.Equal(1, result.FilesDiscovered);
        Assert.Contains("keepMe", JsonSerializer.Serialize(new SymbolQueryService().FindSymbol(_database, "keepMe")));
    }

    private void Write(string relativePath, string content)
    {
        var fullPath = Path.Combine(_root, relativePath.Replace('/', Path.DirectorySeparatorChar));
        Directory.CreateDirectory(Path.GetDirectoryName(fullPath)!);
        File.WriteAllText(fullPath, content);
    }

    public void Dispose()
    {
        SqliteConnection.ClearAllPools();
        try { Directory.Delete(_root, recursive: true); } catch { }
    }
}
