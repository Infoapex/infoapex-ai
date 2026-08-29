using System.Text.Json;
using AiCodeControl.Core.Models;
using AiCodeControl.Core.Services;
using Xunit;

namespace AiCodeControl.Tests;

public sealed class ContextPackageDigestTests
{
    [Fact]
    public void Digest_IsStableAcrossInstanceMetadataAndCollectionOrder()
    {
        var original = CreatePackage();
        var reordered = original with
        {
            PackageId = "ctx-second-instance",
            CreatedAt = original.CreatedAt.AddHours(4),
            Sources = original.Sources.Reverse().ToArray(),
            Budget = original.Budget with
            {
                OmittedSources = original.Budget.OmittedSources.Reverse().ToArray()
            },
            Diagnostics = original.Diagnostics.Reverse().ToArray()
        };

        Assert.Equal(ContextPackageDigest.Compute(original), ContextPackageDigest.Compute(reordered));
    }

    [Theory]
    [InlineData("source-content")]
    [InlineData("source-authority")]
    [InlineData("compiler-version")]
    [InlineData("budget")]
    [InlineData("diagnostic")]
    public void Digest_ChangesWhenSemanticInputChanges(string mutation)
    {
        var original = CreatePackage();
        var changed = mutation switch
        {
            "source-content" => original with
            {
                Sources = ReplaceFirstSource(original, source => source with
                {
                    RenderedContent = source.RenderedContent + " changed",
                    SourceHash = Hash('c')
                })
            },
            "source-authority" => original with
            {
                Sources = ReplaceFirstSource(original, source => source with { Authority = "advisory" })
            },
            "compiler-version" => original with { CompilerVersion = "1.1.0" },
            "budget" => original with
            {
                Budget = original.Budget with { EstimatedTokens = original.Budget.EstimatedTokens + 1 }
            },
            "diagnostic" => original with
            {
                Diagnostics = [new("CTX_NOTE", "warning", "A changed diagnostic", "source-a")]
            },
            _ => throw new ArgumentOutOfRangeException(nameof(mutation))
        };

        Assert.NotEqual(ContextPackageDigest.Compute(original), ContextPackageDigest.Compute(changed));
    }

    [Fact]
    public void ApplyAndJsonCodec_ProduceValidRoundTripContract()
    {
        var package = ContextPackageDigest.Apply(CreatePackage());

        Assert.Empty(ContextPackageDigest.Validate(package));
        var json = ContextPackageJson.Serialize(package);
        var roundTrip = ContextPackageJson.Deserialize(json);

        Assert.Equal(package.SchemaVersion, roundTrip.SchemaVersion);
        Assert.Equal(package.PackageId, roundTrip.PackageId);
        Assert.Equal(package.ContextDigest, roundTrip.ContextDigest);
        Assert.Equal(package.Sources, roundTrip.Sources);
        Assert.Equal(package.Budget.OmittedSources, roundTrip.Budget.OmittedSources);
        Assert.Equal(package.Diagnostics, roundTrip.Diagnostics);
        using var document = JsonDocument.Parse(json);
        var root = document.RootElement;
        Assert.Equal("1.0", root.GetProperty("schemaVersion").GetString());
        Assert.Equal(package.ContextDigest, root.GetProperty("contextDigest").GetString());
        Assert.Equal(JsonValueKind.Null,
            root.GetProperty("sources")[0].GetProperty("sourceCommit").ValueKind);
        Assert.False(root.GetProperty("sources")[0].TryGetProperty("contentRange", out _));
    }

    [Fact]
    public void Validate_RejectsDigestDrift()
    {
        var package = ContextPackageDigest.Apply(CreatePackage());
        var changed = package with { CompilerVersion = "2.0.0" };

        var errors = ContextPackageDigest.Validate(changed);

        Assert.Contains(errors, error => error.Contains("does not match", StringComparison.Ordinal));
    }

    [Fact]
    public void JsonCodec_RejectsUnknownContractFields()
    {
        var json = ContextPackageJson.Serialize(ContextPackageDigest.Apply(CreatePackage()));
        var changed = json.Replace(
            "\"schemaVersion\": \"1.0\"",
            "\"schemaVersion\": \"1.0\",\n  \"unknownField\": true",
            StringComparison.Ordinal);

        Assert.Throws<JsonException>(() => ContextPackageJson.Deserialize(changed));
    }

    [Theory]
    [InlineData("C:/Users/dev/repository/rules.md")]
    [InlineData("/home/dev/repository/rules.md")]
    [InlineData("../repository/rules.md")]
    [InlineData("docs/../secrets.txt")]
    [InlineData("file:///tmp/rules.md")]
    [InlineData("docs\\rules.md")]
    public void Validate_RejectsLocalOrTraversalReferences(string canonicalRef)
    {
        var package = CreatePackage() with
        {
            Sources = ReplaceFirstSource(CreatePackage(), source => source with
            {
                CanonicalRef = canonicalRef
            })
        };

        var error = Assert.Throws<ArgumentException>(() => ContextPackageDigest.Compute(package));
        Assert.Contains("canonicalRef must be stable and non-local", error.Message);
    }

    [Fact]
    public void Validate_RequiresExplicitCharacterFallbackBudget()
    {
        var package = CreatePackage() with
        {
            Budget = CreatePackage().Budget with { Measurement = "characters-fallback" }
        };

        var error = Assert.Throws<ArgumentException>(() => ContextPackageDigest.Compute(package));
        Assert.Contains("character fallback requires", error.Message);
    }

    [Fact]
    public void Validate_RejectsDuplicateAndSimultaneouslyOmittedSources()
    {
        var package = CreatePackage();
        package = package with
        {
            Sources = [package.Sources[0], package.Sources[0]],
            Budget = package.Budget with
            {
                OmittedSources = [new(package.Sources[0].SourceId, "budget", 50)]
            }
        };

        var error = Assert.Throws<ArgumentException>(() => ContextPackageDigest.Compute(package));
        Assert.Contains("duplicate sourceId", error.Message);
        Assert.Contains("both included and omitted", error.Message);
    }

    private static ContextPackage CreatePackage()
    {
        return new ContextPackage(
            SchemaVersion: "1.0",
            PackageId: "ctx-ICM-02-001",
            RunId: "run-001",
            TaskId: "ICM-02",
            ManifestSha256: Hash('a'),
            CompilerVersion: "1.0.0",
            Sources:
            [
                new ContextPackageSource(
                    SourceId: "source-a",
                    SourceType: "contract",
                    CanonicalRef: "contracts/task.v1.schema.json",
                    SourceHash: Hash('b'),
                    SourceCommit: null,
                    Authority: "canonical",
                    SelectionReason: "Task explicitly consumes the worker contract",
                    RenderedContent: "{\"schemaVersion\":\"1.1\"}"),
                new ContextPackageSource(
                    SourceId: "source-b",
                    SourceType: "decision",
                    CanonicalRef: "docs/adr/0001-context.md#decision",
                    SourceHash: Hash('d'),
                    SourceCommit: "abcdef0123456789abcdef0123456789abcdef01",
                    Authority: "advisory",
                    SelectionReason: "Relevant architecture decision",
                    ContentRange: new ContextPackageContentRange(10, 18),
                    RenderedContent: "Use deterministic context selection.")
            ],
            Budget: new ContextPackageBudget(
                Measurement: "tokenizer",
                MaximumTokens: 4000,
                EstimatedTokens: 120,
                OmittedSources:
                [
                    new ContextPackageOmission("source-z", "budget", 900),
                    new ContextPackageOmission("source-y", "policy", 20)
                ]),
            Diagnostics:
            [
                new ContextPackageDiagnostic("CTX_POLICY", "info", "Policy source was omitted"),
                new ContextPackageDiagnostic("CTX_RANGE", "warning", "Only a relevant range was selected", "source-b")
            ],
            ContextDigest: Hash('0'),
            CreatedAt: DateTimeOffset.Parse("2026-08-28T09:00:00Z"));
    }

    private static IReadOnlyList<ContextPackageSource> ReplaceFirstSource(
        ContextPackage package,
        Func<ContextPackageSource, ContextPackageSource> update)
    {
        var result = package.Sources.ToArray();
        result[0] = update(result[0]);
        return result;
    }

    private static string Hash(char character) => new(character, 64);
}
