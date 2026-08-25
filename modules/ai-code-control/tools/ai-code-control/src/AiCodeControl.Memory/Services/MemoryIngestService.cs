using System.Diagnostics;
using System.Security.Cryptography;
using System.Text;
using AiCodeControl.Memory.Models;
using Microsoft.Data.Sqlite;

namespace AiCodeControl.Memory.Services;

public sealed class MemoryIngestService
{
    public IngestResult Ingest(string repoRoot, MemoryConfig config)
    {
        var dbPath = ResolveDbPath(repoRoot, config.Store);
        var result = new IngestResult();
        var allFiles = ResolveIncludedFiles(repoRoot, config);
        var candidates = ReadCandidates(repoRoot, allFiles, result);

        using var connection = OpenConnection(dbPath);
        EnsureRunSchema(connection);
        using var transaction = connection.BeginTransaction();

        result.Pruned = PruneOrphans(connection, transaction, allFiles);
        foreach (var candidate in candidates)
        {
            try
            {
                if (GetExistingHash(connection, transaction, candidate.RelativePath) == candidate.Hash)
                {
                    result.Skipped++;
                    continue;
                }

                UpsertItem(connection, transaction, candidate);
                result.Ingested++;
            }
            catch (Exception ex)
            {
                result.Errors.Add($"{candidate.RelativePath}: {ex.Message}");
            }
        }

        RecordRun(connection, transaction, repoRoot, allFiles.Count, result);
        transaction.Commit();
        return result;
    }

    public int Prune(string repoRoot, MemoryConfig config)
    {
        var dbPath = ResolveDbPath(repoRoot, config.Store);
        if (!File.Exists(dbPath))
            return 0;

        var allFiles = ResolveIncludedFiles(repoRoot, config);
        using var connection = OpenConnection(dbPath);
        using var transaction = connection.BeginTransaction();
        var pruned = PruneOrphans(connection, transaction, allFiles);
        transaction.Commit();
        return pruned;
    }

    internal static HashSet<string> ResolveIncludedFiles(string repoRoot, MemoryConfig config)
    {
        var allFiles = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        foreach (var pattern in config.Include)
        {
            foreach (var relativePath in GlobResolver.Resolve(repoRoot, pattern))
            {
                if (!GlobResolver.IsExcluded(relativePath, config.Exclude))
                    allFiles.Add(relativePath);
            }
        }
        return allFiles;
    }

    internal static string ComputeHash(string content)
        => Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(content))).ToLowerInvariant();

    private static List<MemoryCandidate> ReadCandidates(
        string repoRoot,
        IEnumerable<string> paths,
        IngestResult result)
    {
        var candidates = new List<MemoryCandidate>();
        foreach (var relativePath in paths.OrderBy(path => path, StringComparer.OrdinalIgnoreCase))
        {
            var fullPath = Path.Combine(repoRoot, relativePath.Replace('/', Path.DirectorySeparatorChar));
            try
            {
                var content = File.ReadAllText(fullPath, Encoding.UTF8);
                // Change detection hashes the source file; the indexed copy is a
                // compacted, meaning-preserving derivative that trims token cost for
                // search excerpts and briefs. Markdown only - other formats (JSON) are
                // stored verbatim so their structure stays valid.
                var stored = IsMarkdown(relativePath) ? MarkdownCompactor.Compact(content) : content;
                candidates.Add(new MemoryCandidate(relativePath, ExtractTitle(content, relativePath),
                    ClassifyType(relativePath), stored, ComputeHash(content)));
            }
            catch (Exception ex)
            {
                result.Errors.Add($"{relativePath}: {ex.Message}");
            }
        }
        return candidates;
    }

    private static SqliteConnection OpenConnection(string database)
    {
        var connection = new SqliteConnection($"Data Source={database}");
        connection.Open();
        using var command = connection.CreateCommand();
        command.CommandText = "PRAGMA busy_timeout=10000";
        command.ExecuteNonQuery();
        return connection;
    }

    private static int PruneOrphans(
        SqliteConnection connection,
        SqliteTransaction transaction,
        HashSet<string> currentFiles)
    {
        var stored = new List<string>();
        using (var select = connection.CreateCommand())
        {
            select.Transaction = transaction;
            select.CommandText = "SELECT source_path FROM memory_items";
            using var reader = select.ExecuteReader();
            while (reader.Read()) stored.Add(reader.GetString(0));
        }

        var pruned = 0;
        foreach (var path in stored.Where(path => !currentFiles.Contains(path)))
        {
            using var delete = connection.CreateCommand();
            delete.Transaction = transaction;
            delete.CommandText = "DELETE FROM memory_items WHERE source_path = $path";
            delete.Parameters.AddWithValue("$path", path);
            pruned += delete.ExecuteNonQuery();
        }
        return pruned;
    }

    private static string ResolveDbPath(string repoRoot, string? store)
        => string.IsNullOrEmpty(store)
            ? Path.Combine(repoRoot, ".ai-code-control", "db", "memory.sqlite")
            : Path.IsPathRooted(store)
                ? store
                : Path.Combine(repoRoot, store.Replace('/', Path.DirectorySeparatorChar));

    private static string? GetExistingHash(
        SqliteConnection connection,
        SqliteTransaction transaction,
        string path)
    {
        using var command = connection.CreateCommand();
        command.Transaction = transaction;
        command.CommandText = "SELECT content_hash FROM memory_items WHERE source_path = $path";
        command.Parameters.AddWithValue("$path", path);
        return command.ExecuteScalar() as string;
    }

    private static void UpsertItem(
        SqliteConnection connection,
        SqliteTransaction transaction,
        MemoryCandidate candidate)
    {
        using var command = connection.CreateCommand();
        command.Transaction = transaction;
        command.CommandText = @"
INSERT INTO memory_items(source_path, title, item_type, content, content_hash, updated_at)
VALUES($path, $title, $type, $content, $hash, datetime('now'))
ON CONFLICT(source_path) DO UPDATE SET
    title = excluded.title,
    item_type = excluded.item_type,
    content = excluded.content,
    content_hash = excluded.content_hash,
    updated_at = excluded.updated_at";
        command.Parameters.AddWithValue("$path", candidate.RelativePath);
        command.Parameters.AddWithValue("$title", candidate.Title);
        command.Parameters.AddWithValue("$type", candidate.ItemType);
        command.Parameters.AddWithValue("$content", candidate.Content);
        command.Parameters.AddWithValue("$hash", candidate.Hash);
        command.ExecuteNonQuery();
    }

    private static string ExtractTitle(string content, string fallbackPath)
    {
        foreach (var line in content.Split(new[] { '\r', '\n' }, 6, StringSplitOptions.RemoveEmptyEntries))
        {
            var trimmed = line.Trim();
            if (trimmed.StartsWith("# ", StringComparison.Ordinal))
                return trimmed[2..].Trim();
        }
        return Path.GetFileNameWithoutExtension(fallbackPath);
    }

    private static bool IsMarkdown(string relativePath)
    {
        var lower = relativePath.ToLowerInvariant();
        return lower.EndsWith(".md", StringComparison.Ordinal)
            || lower.EndsWith(".markdown", StringComparison.Ordinal);
    }

    private static string ClassifyType(string relativePath)
    {
        var lower = relativePath.ToLowerInvariant().Replace('\\', '/');
        if (lower.Contains("/decisions/") || lower.Contains("/adr/")) return "adr";
        if (lower.Contains("/tasks/")) return "task";
        if (lower.Contains("/summaries/")) return "summary";
        if (lower.Contains("/handoffs/")) return "handoff";
        if (lower.Contains("/rules/")) return "business-rule";
        if (lower.Contains("/contracts/") || lower.StartsWith("contracts/")) return "contract";
        if (lower is "agents.md" || lower.EndsWith("/agents.md")) return "agents";
        if (lower is "claude.md" || lower.EndsWith("/claude.md")) return "claude";
        if (lower is "refactor_policy.md" || lower.EndsWith("/refactor_policy.md")) return "policy";
        if (lower.EndsWith("project-memory.md")) return "project-memory";
        if (lower.EndsWith(".json")) return "config";
        return "document";
    }

    private static void RecordRun(
        SqliteConnection connection,
        SqliteTransaction transaction,
        string repoRoot,
        int filesSeen,
        IngestResult result)
    {
        var branch = RunGit(repoRoot, "branch --show-current");
        var commit = RunGit(repoRoot, "rev-parse HEAD");
        using var command = connection.CreateCommand();
        command.Transaction = transaction;
        command.CommandText = @"
INSERT INTO memory_ingest_runs(completed_at, branch, git_commit, files_seen,
                               files_ingested, files_skipped, files_pruned, errors)
VALUES(datetime('now'), $branch, $commit, $seen, $ingested, $skipped, $pruned, $errors);";
        command.Parameters.AddWithValue("$branch", string.IsNullOrWhiteSpace(branch) ? DBNull.Value : branch);
        command.Parameters.AddWithValue("$commit", string.IsNullOrWhiteSpace(commit) ? DBNull.Value : commit);
        command.Parameters.AddWithValue("$seen", filesSeen);
        command.Parameters.AddWithValue("$ingested", result.Ingested);
        command.Parameters.AddWithValue("$skipped", result.Skipped);
        command.Parameters.AddWithValue("$pruned", result.Pruned);
        command.Parameters.AddWithValue("$errors", result.Errors.Count);
        command.ExecuteNonQuery();
    }

    private static void EnsureRunSchema(SqliteConnection connection)
    {
        using var command = connection.CreateCommand();
        command.CommandText = @"
CREATE TABLE IF NOT EXISTS memory_ingest_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    completed_at TEXT NOT NULL,
    branch TEXT NULL,
    git_commit TEXT NULL,
    files_seen INTEGER NOT NULL,
    files_ingested INTEGER NOT NULL,
    files_skipped INTEGER NOT NULL,
    files_pruned INTEGER NOT NULL,
    errors INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_memory_ingest_runs_completed ON memory_ingest_runs(completed_at DESC);";
        command.ExecuteNonQuery();
    }

    private static string RunGit(string repoRoot, string arguments)
    {
        try
        {
            using var process = new Process();
            process.StartInfo = new ProcessStartInfo
            {
                FileName = "git",
                Arguments = arguments,
                WorkingDirectory = repoRoot,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false,
                CreateNoWindow = true
            };
            process.Start();
            var stderr = process.StandardError.ReadToEndAsync();
            var output = process.StandardOutput.ReadToEnd();
            process.WaitForExit();
            _ = stderr.GetAwaiter().GetResult();
            return process.ExitCode == 0 ? output.Trim() : string.Empty;
        }
        catch
        {
            return string.Empty;
        }
    }

    private sealed record MemoryCandidate(
        string RelativePath,
        string Title,
        string ItemType,
        string Content,
        string Hash);
}

public sealed class IngestResult
{
    public int Ingested { get; set; }
    public int Skipped { get; set; }
    public int Pruned { get; set; }
    public List<string> Errors { get; set; } = new();
}
