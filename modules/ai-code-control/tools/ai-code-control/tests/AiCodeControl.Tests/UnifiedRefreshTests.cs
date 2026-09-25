using System.Diagnostics;
using System.Text.Json;
using AiCodeControl.Core.Services;
using Microsoft.Data.Sqlite;
using Xunit;

namespace AiCodeControl.Tests;

public sealed class UnifiedRefreshTests : IDisposable
{
    private readonly string root = Path.Combine(Path.GetTempPath(), "unified-refresh", Guid.NewGuid().ToString("N"));

    public UnifiedRefreshTests()
    {
        Write(".ai-code-control/config/code-control.json", """
            {"indexing":{"database":".ai-code-control/db/codegraph.sqlite","languages":{"rust":["crates"],"python":["python"]}}}
            """);
        Write(".ai-code-control/config/memory-control.json", """
            {"memory":{"enabled":true,"store":".ai-code-control/db/memory.sqlite","root":".ai-code-control/memory","include":["AGENTS.md"]}}
            """);
        Write("AGENTS.md", "# Fixture\n");
        Write("crates/domain/Cargo.toml", "[package]\nname = \"domain\"\nversion = \"0.1.0\"\n");
        Write("crates/consumer/Cargo.toml", "[package]\nname = \"consumer\"\nversion = \"0.1.0\"\n[dependencies]\ndomain = { path = \"../domain\" }\n");
        Write("crates/domain/src/lib.rs", "pub struct ReadyBatch;\n");
        Write("crates/consumer/src/lib.rs", "use domain::ReadyBatch;\npub fn consume(batch: ReadyBatch) {}\npub fn unresolved(value: MissingBatch) {}\n");
        Write("python/app.py", "def alpha():\n    pass\n");
        Write("src/App.cs", "public class LegacyCode { public void Run() {} }\n");
        Write("src/app.ts", "export function tsFunction() {}\n");
        Write("src/app.js", "function jsFunction() {}\n");
        Write("src/schema.sql", "CREATE TABLE refresh_fixture (id INT);\n");
    }

    [Fact]
    public void Refresh_IndexesAllLanguagesAndMaintainsGraph()
    {
        var first = Run("refresh");
        Assert.Equal("ok", first.GetProperty("status").GetString());
        Assert.True(Count("SELECT COUNT(*) FROM files WHERE language = 'rust'") >= 2);
        Assert.Equal(1, Count("SELECT COUNT(*) FROM files WHERE language = 'python'"));
        foreach (var language in new[] { "csharp", "typescript", "javascript", "sql" })
            Assert.True(Count("SELECT COUNT(*) FROM files WHERE language = $language", language) > 0);
        Assert.Equal(1, Count("SELECT COUNT(*) FROM symbols WHERE name = 'ReadyBatch'"));
        Assert.Equal(1, Count("SELECT COUNT(*) FROM symbols WHERE name = 'alpha'"));

        var impact = JsonSerializer.SerializeToElement(new SymbolQueryService().ImpactAnalysis(Database, "domain::ReadyBatch"));
        Assert.True(impact.GetProperty("affectedSymbols").GetInt32() > 0);
        var provenance = impact.GetProperty("provenance");
        Assert.Equal("syntax-aware", provenance.GetProperty("analysisMode").GetString());
        Assert.Equal("partial", provenance.GetProperty("semanticCompleteness").GetString());
        Assert.Equal("observed_graph", provenance.GetProperty("riskScope").GetString());
        Assert.True(provenance.GetProperty("unresolvedReferenceCount").GetInt32() > 0);
        Assert.True(Count("SELECT COUNT(*) FROM references_map WHERE symbol_full_name = 'unresolved::MissingBatch'") > 0);
        Assert.Equal(0, Count("SELECT COUNT(*) FROM edges WHERE to_symbol = 'domain::MissingBatch'"));

        var symbolId = Scalar("SELECT id FROM symbols WHERE name = 'ReadyBatch'");
        Run("refresh");
        Assert.Equal(symbolId, Scalar("SELECT id FROM symbols WHERE name = 'ReadyBatch'"));
        Assert.True(Count("SELECT COUNT(*) FROM references_map WHERE symbol_full_name = 'unresolved::MissingBatch'") > 0);
        var health = Run("health-check");
        var run = health.GetProperty("lastIndexRun");
        Assert.Equal("incremental", run.GetProperty("mode").GetString());
        Assert.Contains("rust", run.GetProperty("indexers").EnumerateArray().Select(x => x.GetString()));
        Assert.Contains("python", run.GetProperty("indexers").EnumerateArray().Select(x => x.GetString()));
        Assert.Equal("crates", run.GetProperty("scopes").GetProperty("rust")[0].GetString());
        Assert.False(string.IsNullOrEmpty(run.GetProperty("completedAt").GetString()));

        Write("crates/domain/src/lib.rs", "pub struct RenamedBatch;\n");
        Write("python/app.py", "def beta():\n    pass\n");
        Run("refresh");
        Assert.Equal(0, Count("SELECT COUNT(*) FROM symbols WHERE name = 'ReadyBatch'"));
        Assert.Equal(1, Count("SELECT COUNT(*) FROM symbols WHERE name = 'RenamedBatch'"));
        Assert.Equal(0, Count("SELECT COUNT(*) FROM symbols WHERE name = 'alpha'"));
        Assert.Equal(1, Count("SELECT COUNT(*) FROM symbols WHERE name = 'beta'"));

        File.Delete(Path.Combine(root, "crates/domain/src/lib.rs"));
        File.Delete(Path.Combine(root, "python/app.py"));
        Run("refresh --full");
        Assert.Equal(0, Count("SELECT COUNT(*) FROM symbols WHERE name = 'RenamedBatch'"));
        Assert.Equal(0, Count("SELECT COUNT(*) FROM edges WHERE to_symbol = 'domain::RenamedBatch'"));
        Assert.Equal(0, Count("SELECT COUNT(*) FROM symbols WHERE name = 'beta'"));
        Assert.Equal("full", Run("health-check").GetProperty("lastIndexRun").GetProperty("mode").GetString());
    }

    private string Database => Path.Combine(root, ".ai-code-control/db/codegraph.sqlite");

    private JsonElement Run(string command)
    {
        var configuration = new DirectoryInfo(AppContext.BaseDirectory).Parent!.Name;
        var cli = Path.GetFullPath(Path.Combine(AppContext.BaseDirectory,
            "../../../../../src/AiCodeControl.Cli/bin", configuration, "net10.0/AiCodeControl.Cli.dll"));
        using var process = Process.Start(new ProcessStartInfo("dotnet")
        {
            Arguments = $"\"{cli}\" {command} --repo \"{root}\"",
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false
        })!;
        var output = process.StandardOutput.ReadToEnd();
        var error = process.StandardError.ReadToEnd();
        process.WaitForExit();
        Assert.True(process.ExitCode == 0, output + error);
        return JsonDocument.Parse(output).RootElement.Clone();
    }

    private long Scalar(string sql)
    {
        using var connection = new SqliteConnection($"Data Source={Database}");
        connection.Open();
        using var command = connection.CreateCommand();
        command.CommandText = sql;
        return Convert.ToInt64(command.ExecuteScalar());
    }

    private long Count(string sql, string? language = null)
    {
        using var connection = new SqliteConnection($"Data Source={Database}");
        connection.Open();
        using var command = connection.CreateCommand();
        command.CommandText = sql;
        if (language is not null) command.Parameters.AddWithValue("$language", language);
        return Convert.ToInt64(command.ExecuteScalar());
    }

    private void Write(string path, string content)
    {
        var full = Path.Combine(root, path);
        Directory.CreateDirectory(Path.GetDirectoryName(full)!);
        File.WriteAllText(full, content);
    }

    public void Dispose() => Directory.Delete(root, recursive: true);
}
