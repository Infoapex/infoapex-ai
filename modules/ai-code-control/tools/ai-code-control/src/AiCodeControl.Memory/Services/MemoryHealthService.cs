using System.Text;
using System.Text.Json.Serialization;
using AiCodeControl.Memory.Models;
using Microsoft.Data.Sqlite;

namespace AiCodeControl.Memory.Services;

public sealed class MemoryHealthService
{
    public MemoryHealthResult Check(string repoRoot, MemoryConfig? config)
    {
        var result = new MemoryHealthResult();
        if (config == null)
        {
            result.Status = "config_missing";
            result.Notes.Add("memory-control.json not found or invalid.");
            return result;
        }

        result.Enabled = config.Enabled;
        var dbPath = ResolveDbPath(repoRoot, config.Store);
        result.DatabasePath = Path.GetRelativePath(repoRoot, dbPath).Replace('\\', '/');
        foreach (var source in config.CanonicalSources)
        {
            var fullPath = Path.Combine(repoRoot, source.Replace('/', Path.DirectorySeparatorChar));
            if (!File.Exists(fullPath) && !Directory.Exists(fullPath))
                result.MissingCanonicalSources.Add(source);
        }

        if (!File.Exists(dbPath))
        {
            result.Status = "database_missing";
            result.Notes.Add("memory.sqlite not found. Run: memory-init then memory-ingest.");
            return result;
        }

        try
        {
            using var connection = new SqliteConnection($"Data Source={dbPath}");
            connection.Open();
            var included = MemoryIngestService.ResolveIncludedFiles(repoRoot, config);
            var stored = ReadStoredHashes(connection);
            result.ItemsIndexed = stored.Count;

            foreach (var relativePath in included)
            {
                if (!stored.TryGetValue(relativePath, out var indexedHash))
                {
                    result.UnindexedFiles.Add(relativePath);
                    continue;
                }

                var fullPath = Path.Combine(repoRoot, relativePath.Replace('/', Path.DirectorySeparatorChar));
                var currentHash = MemoryIngestService.ComputeHash(File.ReadAllText(fullPath, Encoding.UTF8));
                if (!string.Equals(indexedHash, currentHash, StringComparison.Ordinal))
                    result.ChangedFiles.Add(relativePath);
            }

            result.OrphanedItems.AddRange(stored.Keys.Where(path => !included.Contains(path)));
            ReadLastRun(connection, result);

            var stale = result.UnindexedFiles.Count > 0 || result.ChangedFiles.Count > 0 ||
                        result.OrphanedItems.Count > 0 || result.MissingCanonicalSources.Count > 0;
            result.Status = stale ? "stale" : "ok";
            if (stale)
                result.Notes.Add("Canonical sources and the search index differ. Run memory-ingest after reviewing the listed files.");
        }
        catch (Exception ex)
        {
            result.Status = "error";
            result.Notes.Add($"Database error: {ex.Message}");
        }

        return result;
    }

    private static Dictionary<string, string> ReadStoredHashes(SqliteConnection connection)
    {
        var result = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        using var command = connection.CreateCommand();
        command.CommandText = "SELECT source_path, content_hash FROM memory_items";
        using var reader = command.ExecuteReader();
        while (reader.Read()) result[reader.GetString(0)] = reader.GetString(1);
        return result;
    }

    private static void ReadLastRun(SqliteConnection connection, MemoryHealthResult result)
    {
        using var tableCheck = connection.CreateCommand();
        tableCheck.CommandText = "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='memory_ingest_runs'";
        if (Convert.ToInt32(tableCheck.ExecuteScalar()) == 0)
            return;
        using var command = connection.CreateCommand();
        command.CommandText = @"
SELECT completed_at, branch, git_commit
FROM memory_ingest_runs
ORDER BY id DESC LIMIT 1";
        using var reader = command.ExecuteReader();
        if (!reader.Read()) return;
        result.LastIngestedAt = reader.GetString(0);
        result.LastIngestedBranch = reader.IsDBNull(1) ? null : reader.GetString(1);
        result.LastIngestedCommit = reader.IsDBNull(2) ? null : reader.GetString(2);
    }

    private static string ResolveDbPath(string repoRoot, string? store)
        => string.IsNullOrEmpty(store)
            ? Path.Combine(repoRoot, ".ai-code-control", "db", "memory.sqlite")
            : Path.IsPathRooted(store)
                ? store
                : Path.Combine(repoRoot, store.Replace('/', Path.DirectorySeparatorChar));
}

public sealed class MemoryHealthResult
{
    [JsonPropertyName("status")] public string Status { get; set; } = "unknown";
    [JsonPropertyName("enabled")] public bool Enabled { get; set; }
    [JsonPropertyName("databasePath")] public string? DatabasePath { get; set; }
    [JsonPropertyName("itemsIndexed")] public int ItemsIndexed { get; set; }
    [JsonPropertyName("lastIngestedAt")] public string? LastIngestedAt { get; set; }
    [JsonPropertyName("lastIngestedBranch")] public string? LastIngestedBranch { get; set; }
    [JsonPropertyName("lastIngestedCommit")] public string? LastIngestedCommit { get; set; }
    [JsonPropertyName("unindexedFiles")] public List<string> UnindexedFiles { get; set; } = new();
    [JsonPropertyName("changedFiles")] public List<string> ChangedFiles { get; set; } = new();
    [JsonPropertyName("orphanedItems")] public List<string> OrphanedItems { get; set; } = new();
    [JsonPropertyName("missingCanonicalSources")] public List<string> MissingCanonicalSources { get; set; } = new();
    [JsonPropertyName("notes")] public List<string> Notes { get; set; } = new();
}
