using AiCodeControl.Core.Services;
using AiCodeControl.Memory.Models;
using AiCodeControl.Memory.Services;
using Microsoft.Data.Sqlite;
using Xunit;

namespace AiCodeControl.Tests;

public sealed class MemoryHealthTests : IDisposable
{
    private readonly string _root;
    private readonly MemoryConfig _config;

    public MemoryHealthTests()
    {
        _root = Path.Combine(Path.GetTempPath(), "acc-memory-health-tests", Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(Path.Combine(_root, "docs"));
        File.WriteAllText(Path.Combine(_root, "docs", "architecture.md"), "# Architecture\n\nInitial state.");
        _config = new MemoryConfig
        {
            Include = new List<string> { "docs/**/*.md" },
            CanonicalSources = new List<string> { "docs/architecture.md" }
        };
        new DatabaseInitializer().InitializeMemory(_root);
    }

    [Fact]
    public void Health_DetectsChangedUnindexedAndOrphanedSources()
    {
        new MemoryIngestService().Ingest(_root, _config);
        Assert.Equal("ok", new MemoryHealthService().Check(_root, _config).Status);

        File.AppendAllText(Path.Combine(_root, "docs", "architecture.md"), "\nChanged.");
        File.WriteAllText(Path.Combine(_root, "docs", "new.md"), "# New");
        var stale = new MemoryHealthService().Check(_root, _config);

        Assert.Equal("stale", stale.Status);
        Assert.Contains("docs/architecture.md", stale.ChangedFiles);
        Assert.Contains("docs/new.md", stale.UnindexedFiles);

        File.Delete(Path.Combine(_root, "docs", "architecture.md"));
        var orphaned = new MemoryHealthService().Check(_root, _config);
        Assert.Contains("docs/architecture.md", orphaned.OrphanedItems);
        Assert.Contains("docs/architecture.md", orphaned.MissingCanonicalSources);
    }

    [Fact]
    public void Brief_EnforcesConfiguredTokenBudget()
    {
        File.WriteAllText(Path.Combine(_root, "docs", "architecture.md"),
            "# Architecture\n\n" + new string('x', 10_000));
        new MemoryIngestService().Ingest(_root, _config);
        _config.MaxBriefingTokens = 300;

        var brief = new MemoryBriefService().GenerateBrief(_root, "architecture", _config);

        Assert.True(brief.Length <= 1_205, $"Brief length was {brief.Length}");
        Assert.Contains("Memory Brief", brief);
    }

    public void Dispose()
    {
        SqliteConnection.ClearAllPools();
        try { Directory.Delete(_root, recursive: true); } catch { }
    }
}
