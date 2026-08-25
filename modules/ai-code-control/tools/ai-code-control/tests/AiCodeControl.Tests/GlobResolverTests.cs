using AiCodeControl.Memory.Services;
using Xunit;

namespace AiCodeControl.Tests;

public sealed class GlobResolverTests
{
    // "**/" means zero or more directory levels — the historical bug made these
    // patterns never match because Regex.Escape does not escape '/'.
    [Theory]
    [InlineData("**/*.md", "project-memory.md", true)]
    [InlineData("**/*.md", "a/b/c.md", true)]
    [InlineData(".ai-code-control/memory/**/*.md", ".ai-code-control/memory/project-memory.md", true)]
    [InlineData(".ai-code-control/memory/**/*.md", ".ai-code-control/memory/decisions/ADR-0001-x.md", true)]
    [InlineData(".ai-code-control/memory/**/*.md", ".ai-code-control/config/code-control.json", false)]
    [InlineData("**/secrets/**", "secrets/key.pem", true)]
    [InlineData("**/secrets/**", "a/b/secrets/key.pem", true)]
    [InlineData("**/secrets/**", "a/secretsy/key.pem", false)]
    [InlineData("*.md", "root.md", true)]
    [InlineData("*.md", "nested/file.md", false)]
    [InlineData("**/*password*", "config/db-password.txt", true)]
    [InlineData("docs/??.md", "docs/ab.md", true)]
    [InlineData("docs/??.md", "docs/abc.md", false)]
    public void Matches_HandlesGlobSemantics(string pattern, string path, bool expected)
    {
        Assert.Equal(expected, GlobResolver.Matches(pattern, path));
    }

    [Fact]
    public void IsExcluded_AppliesSecretsPatternAtAnyDepth()
    {
        var patterns = new[] { "**/secrets/**", "**/*.pem" };
        Assert.True(GlobResolver.IsExcluded("secrets/key.md", patterns));
        Assert.True(GlobResolver.IsExcluded("deep/nested/secrets/key.md", patterns));
        Assert.True(GlobResolver.IsExcluded("certs/server.pem", patterns));
        Assert.False(GlobResolver.IsExcluded("docs/readme.md", patterns));
    }

    [Fact]
    public void Resolve_FindsDirectChildrenAndNestedFiles_ButSkipsGeneratedDirs()
    {
        var root = Path.Combine(Path.GetTempPath(), "acc-tests", Guid.NewGuid().ToString("N"));
        try
        {
            Directory.CreateDirectory(Path.Combine(root, "mem", "decisions"));
            Directory.CreateDirectory(Path.Combine(root, "node_modules", "pkg"));
            File.WriteAllText(Path.Combine(root, "mem", "project.md"), "# P");
            File.WriteAllText(Path.Combine(root, "mem", "decisions", "adr.md"), "# A");
            File.WriteAllText(Path.Combine(root, "node_modules", "pkg", "readme.md"), "# N");

            var memResults = GlobResolver.Resolve(root, "mem/**/*.md").ToList();
            Assert.Contains("mem/project.md", memResults);
            Assert.Contains("mem/decisions/adr.md", memResults);
            Assert.Equal(2, memResults.Count);

            var allResults = GlobResolver.Resolve(root, "**/*.md").ToList();
            Assert.DoesNotContain(allResults, r => r.Contains("node_modules"));
            Assert.Equal(2, allResults.Count);
        }
        finally
        {
            TryDelete(root);
        }
    }

    private static void TryDelete(string path)
    {
        try
        {
            Directory.Delete(path, recursive: true);
        }
        catch
        {
        }
    }
}
