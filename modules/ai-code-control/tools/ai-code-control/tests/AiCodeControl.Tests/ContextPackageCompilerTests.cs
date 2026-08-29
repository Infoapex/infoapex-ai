using AiCodeControl.Core.Models;
using AiCodeControl.Core.Services;
using Xunit;

namespace AiCodeControl.Tests;

public sealed class ContextPackageCompilerTests : IDisposable
{
    private readonly string _root;
    private readonly string _manifest;

    public ContextPackageCompilerTests()
    {
        _root = Path.Combine(Path.GetTempPath(), "acc-context-compiler-tests", Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(Path.Combine(_root, "contracts"));
        Directory.CreateDirectory(Path.Combine(_root, "state"));
        File.WriteAllText(
            Path.Combine(_root, "contracts", "rules.schema.json"),
            "{\n  \"rule\": \"canonical\",\n  \"api_key\": \"secret-value-12345\"\n}\n");
        File.WriteAllText(Path.Combine(_root, "docs.md"), "# Advisory context\n\nStable text.\n");
        _manifest = Path.Combine(_root, "state", "manifest.json");
        WriteManifest(["contracts/rules.schema.json", "docs.md"], ["Missing.Symbol"]);
    }

    [Fact]
    public void Compile_SelectsDeclaredSourcesRedactsAndReportsUnavailableSymbols()
    {
        var package = Compile(maximumTokens: 2000);

        Assert.Empty(ContextPackageDigest.Validate(package));
        Assert.Equal("characters-fallback", package.Budget.Measurement);
        Assert.Equal(2, package.Sources.Count);
        Assert.Contains(package.Sources, source =>
            source.CanonicalRef == "contracts/rules.schema.json" &&
            source.SourceType == "contract" &&
            source.RenderedContent!.Contains("[REDACTED]", StringComparison.Ordinal));
        Assert.Contains(package.Diagnostics, diagnostic => diagnostic.Code == "CTX_CONTENT_REDACTED");
        Assert.Contains(package.Diagnostics, diagnostic => diagnostic.Code == "CTX_SYMBOL_UNAVAILABLE");
        Assert.Contains(package.Budget.OmittedSources, omission => omission.SourceId.StartsWith("symbol-", StringComparison.Ordinal));
    }

    [Fact]
    public void Compile_IsStableAcrossDiscoveryOrderAndCreationTime()
    {
        var first = Compile(maximumTokens: 2000, createdAt: DateTimeOffset.Parse("2026-08-28T10:00:00Z"));
        WriteManifest(["docs.md", "contracts/rules.schema.json"], ["Missing.Symbol"]);
        var second = Compile(maximumTokens: 2000, createdAt: DateTimeOffset.Parse("2026-08-28T11:00:00Z"));

        Assert.Equal(first.ContextDigest, second.ContextDigest);
        Assert.Equal(first.PackageId, second.PackageId);
    }

    [Fact]
    public void Compile_OmitsWholeSourcesInsteadOfSilentlyTruncating()
    {
        var package = Compile(maximumTokens: 1);

        Assert.Empty(package.Sources);
        Assert.Equal(0, package.Budget.EstimatedTokens);
        Assert.Equal(2, package.Budget.OmittedSources.Count(omission => omission.Reason == "budget"));
        Assert.Contains(package.Diagnostics, diagnostic => diagnostic.Code == "CTX_BUDGET_OMISSION");
    }

    [Fact]
    public void Compile_RejectsTraversalAsAnInvalidOmission()
    {
        WriteManifest(["../outside.md"], []);

        var package = Compile(maximumTokens: 100);

        Assert.Empty(package.Sources);
        Assert.Contains(package.Budget.OmittedSources, omission => omission.Reason == "invalid");
        Assert.Contains(package.Diagnostics, diagnostic =>
            diagnostic.Code == "CTX_REFERENCE_INVALID" && diagnostic.Severity == "error");
    }

    private ContextPackage Compile(int maximumTokens, DateTimeOffset? createdAt = null)
    {
        return new ContextPackageCompiler().Compile(new(
            RepositoryRoot: _root,
            ManifestPath: _manifest,
            ManifestSha256: new string('a', 64),
            TaskId: "T1",
            MaximumTokens: maximumTokens,
            CreatedAt: createdAt));
    }

    private void WriteManifest(IReadOnlyList<string> requiredInputs, IReadOnlyList<string> relevantSymbols)
    {
        var requiredJson = string.Join(",", requiredInputs.Select(value => $"\"{value}\""));
        var symbolJson = string.Join(",", relevantSymbols.Select(value => $"\"{value}\""));
        File.WriteAllText(
            _manifest,
            $$"""
            {
              "schemaVersion": "1.1",
              "runId": "run-compiler-001",
              "base": { "commit": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" },
              "tasks": [
                {
                  "id": "T1",
                  "requiredInputs": [{{requiredJson}}],
                  "relevantSymbols": [{{symbolJson}}]
                }
              ]
            }
            """);
    }

    public void Dispose()
    {
        try
        {
            if (Directory.Exists(_root))
            {
                Directory.Delete(_root, recursive: true);
            }
        }
        catch
        {
            // Best-effort cleanup of isolated test data.
        }
    }
}
