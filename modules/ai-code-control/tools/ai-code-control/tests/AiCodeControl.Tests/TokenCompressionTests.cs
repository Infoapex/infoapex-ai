using AiCodeControl.Core.Services;
using AiCodeControl.Memory.Models;
using AiCodeControl.Memory.Services;
using Xunit;

namespace AiCodeControl.Tests;

public sealed class TokenCompressionTests : IDisposable
{
    private readonly string _root;
    private readonly MemoryConfig _config;

    public TokenCompressionTests()
    {
        _root = Path.Combine(Path.GetTempPath(), "acc-token-tests", Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(Path.Combine(_root, ".ai-code-control", "memory", "decisions"));
        _config = new MemoryConfig
        {
            Include = new List<string> { ".ai-code-control/memory/**/*.md" },
            MaxBriefingTokens = 400
        };
        new DatabaseInitializer().InitializeMemory(_root);
    }

    [Fact]
    public void TokenEstimator_IsMonotonicAndProportional()
    {
        Assert.Equal(0, TokenEstimator.Estimate(""));
        var small = TokenEstimator.Estimate("hello world");
        var large = TokenEstimator.Estimate(string.Concat(Enumerable.Repeat("hello world ", 200)));
        Assert.True(small >= 1);
        Assert.True(large > small * 50, $"expected large ({large}) to scale with input vs small ({small})");
    }

    [Fact]
    public void Compact_RemovesDecorationButKeepsCodeAndHeadings()
    {
        const string input =
            "# Title\n\n\n\n<!-- private note -->\n---\nBody line   \n\n```csharp\nvar x =   1;   // keep spacing\n```\n";
        var compact = MarkdownCompactor.Compact(input);

        Assert.Contains("# Title", compact);
        Assert.Contains("Body line", compact);
        Assert.DoesNotContain("private note", compact);      // HTML comment stripped
        Assert.DoesNotContain("\n---\n", "\n" + compact + "\n"); // horizontal rule dropped
        Assert.Contains("var x =   1;   // keep spacing", compact); // code left byte-for-byte
        Assert.DoesNotContain("\n\n\n", compact);            // blank-line runs collapsed
        Assert.True(compact.Length < input.Length);
    }

    [Fact]
    public void HeadByTokens_TruncatesToBudgetOnLineBoundaries()
    {
        var text = string.Join("\n", Enumerable.Range(1, 100).Select(i => $"- bullet number {i} with some words"));
        var head = MarkdownCompactor.HeadByTokens(text, 30);

        Assert.True(TokenEstimator.Estimate(head) <= 30);
        Assert.StartsWith("- bullet number 1", head);
        Assert.DoesNotContain("bullet number 100", head);
    }

    [Fact]
    public void Ingest_StoresCompactedMarkdown_HashTracksSource()
    {
        var file = Path.Combine(_root, ".ai-code-control", "memory", "decisions", "ADR-0001-x.md");
        File.WriteAllText(file, "# ADR-0001\n\n\n\n<!-- reviewer note -->\nDecision body.\n");

        var ingest = new MemoryIngestService().Ingest(_root, _config);
        Assert.Equal(1, ingest.Ingested);

        var search = new MemorySearchService().Search(
            Path.Combine(_root, ".ai-code-control", "db", "memory.sqlite"), "decision body", 5);
        Assert.NotEmpty(search.Matches);

        // Re-ingest without changes: source hash unchanged -> skipped, not re-written.
        var again = new MemoryIngestService().Ingest(_root, _config);
        Assert.Equal(0, again.Ingested);
        Assert.Equal(1, again.Skipped);
    }

    [Fact]
    public void Brief_StaysWithinTokenBudget_AndTokenReportReflectsStore()
    {
        Directory.CreateDirectory(Path.Combine(_root, ".ai-code-control", "memory"));
        File.WriteAllText(
            Path.Combine(_root, ".ai-code-control", "memory", "project-memory.md"),
            "# Project Memory\n\n" + string.Join("\n", Enumerable.Range(1, 300).Select(i => $"- fact {i} about the system")));

        var brief = new MemoryBriefService().GenerateBrief(_root, string.Empty, _config);
        var briefTokens = TokenEstimator.Estimate(brief);
        Assert.True(briefTokens <= _config.MaxBriefingTokens + 30,
            $"brief tokens {briefTokens} should respect budget {_config.MaxBriefingTokens}");
        Assert.Contains("Project memory", brief);

        new MemoryIngestService().Ingest(_root, _config);
        var report = new MemoryTokenReportService().Report(_root, _config);
        Assert.True(report.TotalTokens > 0);
        Assert.True(report.BriefTokens > 0);
        Assert.Equal(_config.MaxBriefingTokens, report.BriefBudget);
    }

    public void Dispose()
    {
        try { if (Directory.Exists(_root)) Directory.Delete(_root, true); }
        catch { /* best effort temp cleanup */ }
    }
}
