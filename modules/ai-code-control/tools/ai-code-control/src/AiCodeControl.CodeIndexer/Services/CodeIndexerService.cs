using System.Diagnostics;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;
using AiCodeControl.CodeIndexer.Models;
using AiCodeControl.CodeIndexer.Parsing;
using Microsoft.Data.Sqlite;

namespace AiCodeControl.CodeIndexer.Services;

public sealed class CodeIndexerService
{
    private static readonly Dictionary<string, string> Languages = new(StringComparer.OrdinalIgnoreCase)
    {
        [".cs"] = "csharp",
        [".ts"] = "typescript",
        [".tsx"] = "typescript",
        [".js"] = "javascript",
        [".jsx"] = "javascript",
        [".sql"] = "sql"
    };

    private static readonly HashSet<string> SkippedDirectories = new(StringComparer.OrdinalIgnoreCase)
    {
        ".git", "node_modules", "bin", "obj", "dist", "build", "target",
        ".next", ".turbo", "coverage", "generated", "__pycache__", ".venv", "venv"
    };

    public CodeIndexResult Index(
        string repoRoot,
        string indexPath,
        string dbPath,
        IEnumerable<string>? excludePatterns = null,
        bool fullRebuild = false)
    {
        var normalizedRoot = Path.GetFullPath(repoRoot);
        var fullIndexPath = Path.GetFullPath(Path.Combine(normalizedRoot, indexPath));
        if (!IsWithin(normalizedRoot, fullIndexPath))
            throw new InvalidOperationException("Index path must stay inside the repository root.");
        if (!Directory.Exists(fullIndexPath))
            throw new DirectoryNotFoundException($"Index path does not exist: {indexPath}");

        var patterns = (excludePatterns ?? Array.Empty<string>()).ToArray();
        var discovered = EnumerateSourceFiles(normalizedRoot, fullIndexPath, patterns)
            .OrderBy(x => x.RelativePath, StringComparer.OrdinalIgnoreCase)
            .ToList();
        var currentPaths = discovered.Select(x => x.RelativePath).ToHashSet(StringComparer.OrdinalIgnoreCase);

        using var connection = new SqliteConnection($"Data Source={dbPath}");
        connection.Open();
        using (var busyTimeout = connection.CreateCommand())
        {
            busyTimeout.CommandText = "PRAGMA busy_timeout=10000";
            busyTimeout.ExecuteNonQuery();
        }
        EnsureSchema(connection);

        var existingHashes = LoadExistingHashes(connection);
        var changed = new List<ParsedCodeFile>();
        var skipped = 0;

        foreach (var source in discovered)
        {
            var content = File.ReadAllText(source.FullPath, Encoding.UTF8);
            var hash = Sha256Hex(content);
            if (!fullRebuild && existingHashes.TryGetValue(source.RelativePath, out var current) &&
                string.Equals(current.Hash, hash, StringComparison.Ordinal) &&
                string.Equals(current.Language, source.Language, StringComparison.OrdinalIgnoreCase))
            {
                skipped++;
                continue;
            }

            var parsed = LanguageParsers.Parse(source.Language, source.RelativePath, content);
            changed.Add(new ParsedCodeFile(source.RelativePath, source.Language, hash, parsed.Symbols, parsed.References));
        }

        var branch = RunGit(normalizedRoot, "branch --show-current");
        var commit = RunGit(normalizedRoot, "rev-parse HEAD");
        var symbolsIndexed = 0;
        var referencesIndexed = 0;
        var filesPruned = 0;
        var edgesRebuilt = 0;

        using (var tx = connection.BeginTransaction())
        {
            if (fullRebuild)
                DeleteSupportedLanguageRows(connection, tx, normalizedRoot, fullIndexPath);

            foreach (var file in changed)
            {
                var fileId = UpsertFile(connection, tx, file);
                DeleteFileScopedRows(connection, tx, fileId);
                foreach (var symbol in file.Symbols)
                {
                    InsertSymbol(connection, tx, fileId, file.Language, symbol);
                    symbolsIndexed++;
                }
                foreach (var reference in file.References)
                {
                    InsertReference(connection, tx, fileId, reference);
                    referencesIndexed++;
                }
            }

            filesPruned = PruneMissingFiles(connection, tx, normalizedRoot, fullIndexPath, currentPaths);
            ResolveAllReferences(connection, tx);
            edgesRebuilt = RebuildEdges(connection, tx);
            InsertRun(connection, tx, fullRebuild ? "full" : "incremental", indexPath,
                discovered.Count, changed.Count, skipped, filesPruned, branch, commit);
            tx.Commit();
        }

        return new CodeIndexResult(fullRebuild ? "full" : "incremental", discovered.Count,
            changed.Count, skipped, filesPruned, symbolsIndexed, referencesIndexed,
            edgesRebuilt, NullIfEmpty(branch), NullIfEmpty(commit));
    }

    private static IEnumerable<SourceFile> EnumerateSourceFiles(
        string repoRoot,
        string root,
        IReadOnlyCollection<string> excludePatterns)
    {
        var pending = new Stack<string>();
        pending.Push(root);
        while (pending.Count > 0)
        {
            var directory = pending.Pop();
            foreach (var child in SafeDirectories(directory))
            {
                if (!SkippedDirectories.Contains(Path.GetFileName(child)))
                    pending.Push(child);
            }

            foreach (var file in SafeFiles(directory))
            {
                var extension = Path.GetExtension(file);
                if (!Languages.TryGetValue(extension, out var language))
                    continue;
                if (file.EndsWith(".d.ts", StringComparison.OrdinalIgnoreCase))
                    continue;
                var relative = Path.GetRelativePath(repoRoot, file).Replace('\\', '/');
                if (excludePatterns.Any(pattern => GlobMatches(pattern, relative)))
                    continue;
                yield return new SourceFile(file, relative, language);
            }
        }
    }

    private static IEnumerable<string> SafeDirectories(string path)
    {
        try { return Directory.EnumerateDirectories(path).ToArray(); }
        catch (IOException) { return Array.Empty<string>(); }
        catch (UnauthorizedAccessException) { return Array.Empty<string>(); }
    }

    private static IEnumerable<string> SafeFiles(string path)
    {
        try { return Directory.EnumerateFiles(path).ToArray(); }
        catch (IOException) { return Array.Empty<string>(); }
        catch (UnauthorizedAccessException) { return Array.Empty<string>(); }
    }

    private static bool GlobMatches(string pattern, string relativePath)
    {
        var normalized = pattern.Replace('\\', '/');
        var regex = "^" + Regex.Escape(normalized)
            .Replace(@"\*\*/", @"([^/]+/)*")
            .Replace(@"\*\*", @".*")
            .Replace(@"\*", @"[^/]*")
            .Replace(@"\?", @"[^/]") + "$";
        return Regex.IsMatch(relativePath, regex, RegexOptions.IgnoreCase);
    }

    private static Dictionary<string, ExistingFile> LoadExistingHashes(SqliteConnection connection)
    {
        var result = new Dictionary<string, ExistingFile>(StringComparer.OrdinalIgnoreCase);
        using var command = connection.CreateCommand();
        command.CommandText = "SELECT path, language, hash FROM files";
        using var reader = command.ExecuteReader();
        while (reader.Read())
            result[reader.GetString(0)] = new ExistingFile(reader.GetString(1), reader.GetString(2));
        return result;
    }

    private static long UpsertFile(SqliteConnection connection, SqliteTransaction tx, ParsedCodeFile file)
    {
        using var command = connection.CreateCommand();
        command.Transaction = tx;
        command.CommandText = @"
INSERT INTO files(path, language, hash, indexed_at)
VALUES($path, $language, $hash, datetime('now'))
ON CONFLICT(path) DO UPDATE SET
  language = excluded.language,
  hash = excluded.hash,
  indexed_at = excluded.indexed_at
RETURNING id;";
        command.Parameters.AddWithValue("$path", file.RelativePath);
        command.Parameters.AddWithValue("$language", file.Language);
        command.Parameters.AddWithValue("$hash", file.Hash);
        return (long)(command.ExecuteScalar() ?? 0L);
    }

    private static void DeleteFileScopedRows(SqliteConnection connection, SqliteTransaction tx, long fileId)
    {
        foreach (var table in new[] { "symbols", "references_map", "edges" })
        {
            using var command = connection.CreateCommand();
            command.Transaction = tx;
            command.CommandText = $"DELETE FROM {table} WHERE file_id = $fileId";
            command.Parameters.AddWithValue("$fileId", fileId);
            command.ExecuteNonQuery();
        }
    }

    private static void InsertSymbol(
        SqliteConnection connection,
        SqliteTransaction tx,
        long fileId,
        string language,
        CodeSymbol symbol)
    {
        using var command = connection.CreateCommand();
        command.Transaction = tx;
        command.CommandText = @"
INSERT INTO symbols(file_id, name, full_name, kind, language, start_line, end_line, accessibility, parent_symbol)
VALUES($fileId, $name, $fullName, $kind, $language, $start, $end, $accessibility, $parent);";
        command.Parameters.AddWithValue("$fileId", fileId);
        command.Parameters.AddWithValue("$name", symbol.Name);
        command.Parameters.AddWithValue("$fullName", symbol.FullName);
        command.Parameters.AddWithValue("$kind", symbol.Kind);
        command.Parameters.AddWithValue("$language", language);
        command.Parameters.AddWithValue("$start", symbol.StartLine);
        command.Parameters.AddWithValue("$end", symbol.EndLine);
        command.Parameters.AddWithValue("$accessibility", (object?)symbol.Accessibility ?? DBNull.Value);
        command.Parameters.AddWithValue("$parent", (object?)symbol.ParentSymbol ?? DBNull.Value);
        command.ExecuteNonQuery();
    }

    private static void InsertReference(
        SqliteConnection connection,
        SqliteTransaction tx,
        long fileId,
        CodeReference reference)
    {
        using var command = connection.CreateCommand();
        command.Transaction = tx;
        command.CommandText = @"
INSERT INTO references_map(symbol_full_name, reference_token, referenced_from_symbol, file_id, line, column, reference_kind)
VALUES($token, $token, $from, $fileId, $line, $column, $kind);";
        command.Parameters.AddWithValue("$token", reference.Token);
        command.Parameters.AddWithValue("$from", (object?)reference.ReferencedFromSymbol ?? DBNull.Value);
        command.Parameters.AddWithValue("$fileId", fileId);
        command.Parameters.AddWithValue("$line", reference.Line);
        command.Parameters.AddWithValue("$column", reference.Column);
        command.Parameters.AddWithValue("$kind", reference.Kind);
        command.ExecuteNonQuery();
    }

    private static int PruneMissingFiles(
        SqliteConnection connection,
        SqliteTransaction tx,
        string repoRoot,
        string scopeRoot,
        HashSet<string> currentPaths)
    {
        var rows = new List<(long Id, string Path)>();
        using (var command = connection.CreateCommand())
        {
            command.Transaction = tx;
            command.CommandText = "SELECT id, path FROM files WHERE language IN ('csharp','typescript','javascript','sql')";
            using var reader = command.ExecuteReader();
            while (reader.Read())
                rows.Add((reader.GetInt64(0), reader.GetString(1)));
        }

        var pruned = 0;
        foreach (var row in rows)
        {
            var absolute = Path.GetFullPath(Path.Combine(repoRoot, row.Path.Replace('/', Path.DirectorySeparatorChar)));
            if (!IsWithin(scopeRoot, absolute) || currentPaths.Contains(row.Path))
                continue;
            DeleteFileScopedRows(connection, tx, row.Id);
            using var delete = connection.CreateCommand();
            delete.Transaction = tx;
            delete.CommandText = "DELETE FROM files WHERE id = $id";
            delete.Parameters.AddWithValue("$id", row.Id);
            pruned += delete.ExecuteNonQuery();
        }
        return pruned;
    }

    private static void DeleteSupportedLanguageRows(
        SqliteConnection connection,
        SqliteTransaction tx,
        string repoRoot,
        string scopeRoot)
    {
        var rows = new List<(long Id, string Path)>();
        using (var select = connection.CreateCommand())
        {
            select.Transaction = tx;
            select.CommandText = "SELECT id, path FROM files WHERE language IN ('csharp','typescript','javascript','sql')";
            using var reader = select.ExecuteReader();
            while (reader.Read()) rows.Add((reader.GetInt64(0), reader.GetString(1)));
        }
        foreach (var row in rows)
        {
            var absolute = Path.GetFullPath(Path.Combine(repoRoot, row.Path.Replace('/', Path.DirectorySeparatorChar)));
            if (!IsWithin(scopeRoot, absolute))
                continue;
            DeleteFileScopedRows(connection, tx, row.Id);
            using var delete = connection.CreateCommand();
            delete.Transaction = tx;
            delete.CommandText = "DELETE FROM files WHERE id = $id";
            delete.Parameters.AddWithValue("$id", row.Id);
            delete.ExecuteNonQuery();
        }
    }

    private static void ResolveAllReferences(SqliteConnection connection, SqliteTransaction tx)
    {
        using var reset = connection.CreateCommand();
        reset.Transaction = tx;
        reset.CommandText = "UPDATE references_map SET symbol_full_name = reference_token WHERE reference_token IS NOT NULL";
        reset.ExecuteNonQuery();

        using var resolve = connection.CreateCommand();
        resolve.Transaction = tx;
        resolve.CommandText = @"
UPDATE references_map
SET symbol_full_name = (
    SELECT MIN(s.full_name)
    FROM symbols s
    WHERE s.name = references_map.reference_token OR s.full_name = references_map.reference_token
)
WHERE reference_token IS NOT NULL
  AND (SELECT COUNT(DISTINCT s.full_name) FROM symbols s
       WHERE s.name = references_map.reference_token OR s.full_name = references_map.reference_token) = 1;";
        resolve.ExecuteNonQuery();
    }

    private static int RebuildEdges(SqliteConnection connection, SqliteTransaction tx)
    {
        using var delete = connection.CreateCommand();
        delete.Transaction = tx;
        delete.CommandText = "DELETE FROM edges WHERE edge_type IN ('calls','imports','references','from','join','update','into','call')";
        delete.ExecuteNonQuery();

        using var insert = connection.CreateCommand();
        insert.Transaction = tx;
        insert.CommandText = @"
INSERT INTO edges(from_symbol, to_symbol, edge_type, file_id)
SELECT referenced_from_symbol, symbol_full_name, reference_kind, file_id
FROM references_map
WHERE referenced_from_symbol IS NOT NULL AND symbol_full_name IS NOT NULL;";
        return insert.ExecuteNonQuery();
    }

    private static void InsertRun(
        SqliteConnection connection,
        SqliteTransaction tx,
        string mode,
        string scope,
        int discovered,
        int indexed,
        int skipped,
        int pruned,
        string branch,
        string commit)
    {
        using var command = connection.CreateCommand();
        command.Transaction = tx;
        command.CommandText = @"
INSERT INTO code_index_runs(started_at, completed_at, mode, scope, branch, git_commit,
                            files_discovered, files_indexed, files_skipped, files_pruned)
VALUES(datetime('now'), datetime('now'), $mode, $scope, $branch, $commit,
       $discovered, $indexed, $skipped, $pruned);";
        command.Parameters.AddWithValue("$mode", mode);
        command.Parameters.AddWithValue("$scope", scope);
        command.Parameters.AddWithValue("$branch", NullIfEmpty(branch) is { } b ? b : DBNull.Value);
        command.Parameters.AddWithValue("$commit", NullIfEmpty(commit) is { } c ? c : DBNull.Value);
        command.Parameters.AddWithValue("$discovered", discovered);
        command.Parameters.AddWithValue("$indexed", indexed);
        command.Parameters.AddWithValue("$skipped", skipped);
        command.Parameters.AddWithValue("$pruned", pruned);
        command.ExecuteNonQuery();
    }

    private static void EnsureSchema(SqliteConnection connection)
    {
        EnsureColumn(connection, "references_map", "reference_token", "TEXT NULL");
        using var command = connection.CreateCommand();
        command.CommandText = @"
CREATE TABLE IF NOT EXISTS code_index_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    started_at TEXT NOT NULL,
    completed_at TEXT NOT NULL,
    mode TEXT NOT NULL,
    scope TEXT NOT NULL,
    branch TEXT NULL,
    git_commit TEXT NULL,
    files_discovered INTEGER NOT NULL,
    files_indexed INTEGER NOT NULL,
    files_skipped INTEGER NOT NULL,
    files_pruned INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_code_index_runs_completed ON code_index_runs(completed_at DESC);
CREATE INDEX IF NOT EXISTS idx_references_token ON references_map(reference_token);";
        command.ExecuteNonQuery();
    }

    private static void EnsureColumn(SqliteConnection connection, string table, string column, string definition)
    {
        using var pragma = connection.CreateCommand();
        pragma.CommandText = $"PRAGMA table_info({table})";
        using var reader = pragma.ExecuteReader();
        while (reader.Read())
            if (string.Equals(reader.GetString(1), column, StringComparison.OrdinalIgnoreCase))
                return;
        reader.Close();
        using var alter = connection.CreateCommand();
        alter.CommandText = $"ALTER TABLE {table} ADD COLUMN {column} {definition}";
        alter.ExecuteNonQuery();
    }

    private static string Sha256Hex(string content)
        => Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(content))).ToLowerInvariant();

    private static bool IsWithin(string root, string candidate)
    {
        var normalizedRoot = Path.GetFullPath(root).TrimEnd(Path.DirectorySeparatorChar) + Path.DirectorySeparatorChar;
        var normalizedCandidate = Path.GetFullPath(candidate);
        return normalizedCandidate.StartsWith(normalizedRoot, StringComparison.OrdinalIgnoreCase) ||
               string.Equals(normalizedCandidate.TrimEnd(Path.DirectorySeparatorChar),
                   normalizedRoot.TrimEnd(Path.DirectorySeparatorChar), StringComparison.OrdinalIgnoreCase);
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

    private static string? NullIfEmpty(string value) => string.IsNullOrWhiteSpace(value) ? null : value;

    private sealed record SourceFile(string FullPath, string RelativePath, string Language);
    private sealed record ExistingFile(string Language, string Hash);
}
