using AiCodeControl.Core.Models;
using Microsoft.Data.Sqlite;

namespace AiCodeControl.Core.Services;

public sealed class HealthCheckService
{
    public object Build(string repoRoot, CodeControlConfig? config)
    {
        var codegraphDb = Resolve(repoRoot, config?.Indexing?.Database,
            Path.Combine(".ai-code-control", "db", "codegraph.sqlite"));
        var memoryDb = Path.Combine(repoRoot, ".ai-code-control", "db", "memory.sqlite");
        var stats = File.Exists(codegraphDb) ? ReadCodegraphStats(codegraphDb) : new CodegraphStats();

        return new
        {
            status = File.Exists(codegraphDb) && File.Exists(memoryDb) ? "ok" : "degraded",
            codegraphDatabase = File.Exists(codegraphDb) ? "ok" : "missing",
            memoryDatabase = File.Exists(memoryDb) ? "ok" : "missing",
            stats.Files,
            stats.Symbols,
            stats.References,
            stats.Edges,
            filesByLanguage = stats.FilesByLanguage,
            lastIndexRun = stats.LastRun,
            configLoaded = config is not null,
            toolchainsConfigured = config?.Toolchains?
                .Where(toolchain => toolchain.Enabled)
                .Select(toolchain => toolchain.Name ?? "unnamed")
                .ToArray() ?? Array.Empty<string>(),
            memoryEnabled = File.Exists(Path.Combine(repoRoot, ".ai-code-control", "config", "memory-control.json"))
        };
    }

    private static CodegraphStats ReadCodegraphStats(string database)
    {
        using var connection = new SqliteConnection($"Data Source={database}");
        connection.Open();
        var result = new CodegraphStats
        {
            Files = Count(connection, "files"),
            Symbols = Count(connection, "symbols"),
            References = Count(connection, "references_map"),
            Edges = Count(connection, "edges")
        };

        using (var languages = connection.CreateCommand())
        {
            languages.CommandText = "SELECT language, COUNT(*) FROM files GROUP BY language ORDER BY language";
            using var reader = languages.ExecuteReader();
            while (reader.Read()) result.FilesByLanguage[reader.GetString(0)] = reader.GetInt64(1);
        }

        using var table = connection.CreateCommand();
        table.CommandText = "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='code_index_runs'";
        if (Convert.ToInt32(table.ExecuteScalar()) == 0)
            return result;
        using var last = connection.CreateCommand();
        last.CommandText = @"
SELECT completed_at, mode, scope, branch, git_commit, files_discovered,
       files_indexed, files_skipped, files_pruned
FROM code_index_runs ORDER BY id DESC LIMIT 1";
        using var lastReader = last.ExecuteReader();
        if (lastReader.Read())
        {
            result.LastRun = new
            {
                completedAt = lastReader.GetString(0),
                mode = lastReader.GetString(1),
                scope = lastReader.GetString(2),
                branch = lastReader.IsDBNull(3) ? null : lastReader.GetString(3),
                commit = lastReader.IsDBNull(4) ? null : lastReader.GetString(4),
                filesDiscovered = lastReader.GetInt32(5),
                filesIndexed = lastReader.GetInt32(6),
                filesSkipped = lastReader.GetInt32(7),
                filesPruned = lastReader.GetInt32(8)
            };
        }
        return result;
    }

    private static long Count(SqliteConnection connection, string table)
    {
        using var command = connection.CreateCommand();
        command.CommandText = $"SELECT COUNT(*) FROM {table}";
        return Convert.ToInt64(command.ExecuteScalar());
    }

    private static string Resolve(string repoRoot, string? configured, string fallback)
        => string.IsNullOrWhiteSpace(configured)
            ? Path.Combine(repoRoot, fallback)
            : Path.IsPathRooted(configured)
                ? configured
                : Path.Combine(repoRoot, configured.Replace('/', Path.DirectorySeparatorChar));

    private sealed class CodegraphStats
    {
        public long Files { get; set; }
        public long Symbols { get; set; }
        public long References { get; set; }
        public long Edges { get; set; }
        public Dictionary<string, long> FilesByLanguage { get; } = new(StringComparer.OrdinalIgnoreCase);
        public object? LastRun { get; set; }
    }
}
