using System.Text.Json;
using AiCodeControl.Core.Services;
using AiCodeControl.Memory.Models;
using AiCodeControl.Memory.Services;
using Microsoft.Data.Sqlite;
using Xunit;

namespace AiCodeControl.Tests;

public sealed class MemoryIngestTests : IDisposable
{
    private readonly string _root;

    public MemoryIngestTests()
    {
        _root = Path.Combine(Path.GetTempPath(), "acc-tests", Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(Path.Combine(_root, ".ai-code-control", "memory", "decisions"));
        File.WriteAllText(
            Path.Combine(_root, ".ai-code-control", "memory", "project-memory.md"),
            "# Project Memory\n\nStatus: testing ingest idempotency.\n");
        File.WriteAllText(
            Path.Combine(_root, ".ai-code-control", "memory", "decisions", "ADR-0001-test.md"),
            "# ADR-0001 - Test decision\n\nUse SQLite FTS for memory search.\n");
        new DatabaseInitializer().InitializeMemory(_root);
    }

    private static MemoryConfig Config => new()
    {
        Include = new List<string> { ".ai-code-control/memory/**/*.md" },
        Exclude = new List<string> { "**/secrets/**" }
    };

    [Fact]
    public void Ingest_IncludesDirectChildrenOfMemoryRoot_AndIsIdempotent()
    {
        var first = new MemoryIngestService().Ingest(_root, Config);

        // project-memory.md sits DIRECTLY under memory/ — the "**/" bug used to
        // silently drop it from the index.
        Assert.Empty(first.Errors);
        Assert.Equal(2, first.Ingested);

        var second = new MemoryIngestService().Ingest(_root, Config);
        Assert.Empty(second.Errors);
        Assert.Equal(0, second.Ingested);
        Assert.Equal(2, second.Skipped);
    }

    [Fact]
    public void Ingest_ExcludesSecrets()
    {
        var secretsDir = Path.Combine(_root, ".ai-code-control", "memory", "secrets");
        Directory.CreateDirectory(secretsDir);
        File.WriteAllText(Path.Combine(secretsDir, "api-key.md"), "# Secret\n\ntoken=abc123\n");

        var result = new MemoryIngestService().Ingest(_root, Config);

        Assert.Equal(2, result.Ingested);
        Assert.DoesNotContain(result.Errors, e => e.Contains("secrets"));

        var searchJson = JsonSerializer.Serialize(
            new MemorySearchService().Search(MemoryDbPath, "abc123", 8));
        Assert.DoesNotContain("api-key", searchJson);
    }

    [Fact]
    public void Search_FindsIngestedContentByKeyword()
    {
        new MemoryIngestService().Ingest(_root, Config);

        var searchJson = JsonSerializer.Serialize(
            new MemorySearchService().Search(MemoryDbPath, "FTS", 8));

        Assert.Contains("ADR-0001", searchJson);
    }

    [Fact]
    public void Search_IsDiacriticsInsensitive()
    {
        // User-authored memory may contain Romanian diacritics; an ASCII query
        // must still find it (tokenizer: unicode61 remove_diacritics 2).
        File.WriteAllText(
            Path.Combine(_root, ".ai-code-control", "memory", "decisions", "ADR-0002-diacritice.md"),
            "# ADR-0002 - Decizie despre operațiuni\n\nGestionăm operațiunile de livrare.\n");
        new MemoryIngestService().Ingest(_root, Config);

        var searchJson = JsonSerializer.Serialize(
            new MemorySearchService().Search(MemoryDbPath, "operatiuni", 8));

        Assert.Contains("ADR-0002", searchJson);
    }

    [Fact]
    public void Ingest_PrunesEntriesForDeletedFiles()
    {
        var extraPath = Path.Combine(_root, ".ai-code-control", "memory", "tasks");
        Directory.CreateDirectory(extraPath);
        var tempDoc = Path.Combine(extraPath, "2026-07-05-temp.md");
        File.WriteAllText(tempDoc, "# Temp task\n\nUnique marker: zebra-quantum.\n");

        var first = new MemoryIngestService().Ingest(_root, Config);
        Assert.Equal(3, first.Ingested);

        File.Delete(tempDoc);
        var second = new MemoryIngestService().Ingest(_root, Config);
        Assert.Equal(1, second.Pruned);

        var searchJson = JsonSerializer.Serialize(
            new MemorySearchService().Search(MemoryDbPath, "zebra-quantum", 8));
        Assert.DoesNotContain("2026-07-05-temp", searchJson);
    }

    [Fact]
    public async Task Ingest_ConcurrentWriters_LeaveAConsistentIndex()
    {
        var first = Task.Run(() => new MemoryIngestService().Ingest(_root, Config));
        var second = Task.Run(() => new MemoryIngestService().Ingest(_root, Config));

        var results = await Task.WhenAll(first, second);

        Assert.All(results, result => Assert.Empty(result.Errors));
        using var connection = new SqliteConnection($"Data Source={MemoryDbPath}");
        connection.Open();
        using var count = connection.CreateCommand();
        count.CommandText = "SELECT COUNT(*) FROM memory_items";
        Assert.Equal(2L, Convert.ToInt64(count.ExecuteScalar()));
    }

    private string MemoryDbPath => Path.Combine(_root, ".ai-code-control", "db", "memory.sqlite");

    public void Dispose()
    {
        SqliteConnection.ClearAllPools();
        try
        {
            Directory.Delete(_root, recursive: true);
        }
        catch
        {
        }
    }
}
