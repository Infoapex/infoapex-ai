using AiCodeControl.RustIndexer.Models;
using Microsoft.Data.Sqlite;

namespace AiCodeControl.RustIndexer.Services;

public sealed class RustIndexerService
{
    private static readonly HashSet<string> ExcludedDirs = new(StringComparer.OrdinalIgnoreCase)
    {
        "target", ".git", "node_modules", "bin", "obj"
    };

    public RustIndexResult Index(string repoRoot, string indexPath, string dbPath, bool fullRebuild = false)
    {
        var root = Path.GetFullPath(Path.Combine(repoRoot, indexPath));
        var cargoTomls = Directory.EnumerateFiles(root, "Cargo.toml", SearchOption.AllDirectories)
            .Where(p => !IsExcludedPath(root, p)).Order(StringComparer.Ordinal).ToList();
        var crates = cargoTomls.Select(p => (Path: p, Root: Path.GetDirectoryName(p)!, Metadata: ReadCargoMetadataFallback(p)))
            .Where(c => !string.IsNullOrWhiteSpace(c.Metadata.Name)).ToList();
        var rsFiles = Directory.EnumerateFiles(root, "*.rs", SearchOption.AllDirectories)
            .Where(p => !IsExcludedPath(root, p)).Order(StringComparer.Ordinal).ToList();
        var parsed = rsFiles.Select(file =>
        {
            var owner = crates.Where(c => file.StartsWith(c.Root + Path.DirectorySeparatorChar, StringComparison.Ordinal))
                .OrderByDescending(c => c.Root.Length).FirstOrDefault();
            var crateName = owner.Metadata.Name?.Replace('-', '_') ?? Path.GetFileName(root).Replace('-', '_');
            return RustSyntaxParser.Parse(repoRoot, file, crateName, owner.Root ?? root);
        }).ToList();
        var resolver = new RustReferenceResolver(parsed);

        using var conn = new SqliteConnection($"Data Source={dbPath}");
        conn.Open();
        if (!fullRebuild && IsCurrent(conn, repoRoot, root, parsed) && CratesCurrent(conn, repoRoot, root, cargoTomls))
            return new RustIndexResult(crates.Count, 0, 0, 0, 0, 0);
        using var tx = conn.BeginTransaction();
        PruneMissingCrates(conn, tx, repoRoot, root,
            crates.Select(crate => Path.GetRelativePath(repoRoot, crate.Path).Replace('\\', '/')).ToHashSet(StringComparer.Ordinal));
        var dependenciesIndexed = 0;
        foreach (var crate in crates)
        {
            var crateId = UpsertRustCrate(conn, tx, crate.Metadata.Name!, Path.GetRelativePath(repoRoot, crate.Path).Replace('\\', '/'));
            DeleteRustDependencies(conn, tx, crateId);
            foreach (var dep in crate.Metadata.Dependencies)
            {
                InsertRustDependency(conn, tx, crateId, dep, "normal", null);
                dependenciesIndexed++;
            }
        }

        var discovered = parsed.Select(f => f.RelativePath).ToHashSet(StringComparer.Ordinal);
        PruneMissingRustFiles(conn, tx, repoRoot, root, discovered);
        var symbolsIndexed = 0;
        var refsIndexed = 0;
        var edgesIndexed = 0;
        foreach (var file in parsed)
        {
            var fileId = UpsertFile(conn, tx, file.RelativePath, file.Hash);
            DeleteFileScopedRows(conn, tx, fileId);
            foreach (var symbol in file.Symbols)
            {
                InsertSymbol(conn, tx, fileId, symbol);
                symbolsIndexed++;
                if (symbol.ParentSymbol is not null && resolver.HasSymbol(symbol.ParentSymbol))
                {
                    InsertEdge(conn, tx, fileId, symbol.FullName, symbol.ParentSymbol, "member_of");
                    edgesIndexed++;
                }
            }
            foreach (var reference in file.References)
            {
                var resolved = resolver.Resolve(file, reference.SymbolToken, reference.ReferencedFromSymbol);
                InsertReference(conn, tx, fileId, resolved ?? "unresolved::" + reference.SymbolToken, reference);
                refsIndexed++;
                if (resolved is not null && reference.ReferencedFromSymbol is not null && reference.ReferencedFromSymbol != resolved)
                {
                    InsertEdge(conn, tx, fileId, reference.ReferencedFromSymbol, resolved, reference.EdgeType);
                    edgesIndexed++;
                }
            }
        }
        tx.Commit();
        return new RustIndexResult(crates.Count, dependenciesIndexed, parsed.Count, symbolsIndexed, refsIndexed, edgesIndexed);
    }

    private static bool IsCurrent(SqliteConnection conn, string repoRoot, string root, List<RustFileIndex> parsed)
    {
        var expected = parsed.ToDictionary(file => file.RelativePath, file => file.Hash, StringComparer.Ordinal);
        using var query = conn.CreateCommand();
        query.CommandText = "SELECT path, hash FROM files WHERE language = 'rust'";
        using var reader = query.ExecuteReader();
        var seen = 0;
        while (reader.Read())
        {
            var path = reader.GetString(0);
            var absolute = Path.GetFullPath(Path.Combine(repoRoot, path));
            if (absolute != root && !absolute.StartsWith(root + Path.DirectorySeparatorChar, StringComparison.Ordinal)) continue;
            if (!expected.TryGetValue(path, out var hash) || hash != reader.GetString(1)) return false;
            seen++;
        }
        return seen == expected.Count && expected.Count > 0;
    }

    private static bool CratesCurrent(SqliteConnection conn, string repoRoot, string root, List<string> manifests)
    {
        var expected = manifests.ToDictionary(path => Path.GetRelativePath(repoRoot, path).Replace('\\', '/'),
            ReadCargoMetadataFallback, StringComparer.Ordinal);
        using var query = conn.CreateCommand();
        query.CommandText = "SELECT id, manifest_path, name FROM rust_crates";
        var rows = new List<(long Id, string Path, string Name)>();
        using (var reader = query.ExecuteReader())
            while (reader.Read()) rows.Add((reader.GetInt64(0), reader.GetString(1), reader.GetString(2)));
        var seen = 0;
        foreach (var row in rows)
        {
            var absolute = Path.GetFullPath(Path.Combine(repoRoot, row.Path));
            if (absolute != root && !absolute.StartsWith(root + Path.DirectorySeparatorChar, StringComparison.Ordinal)) continue;
            if (!expected.TryGetValue(row.Path, out var metadata) || metadata.Name != row.Name) return false;
            using var dependencies = conn.CreateCommand();
            dependencies.CommandText = "SELECT dependency_name FROM rust_dependencies WHERE crate_id = $id ORDER BY dependency_name";
            dependencies.Parameters.AddWithValue("$id", row.Id);
            var actual = new List<string>();
            using (var reader = dependencies.ExecuteReader())
                while (reader.Read()) actual.Add(reader.GetString(0));
            if (!actual.SequenceEqual(metadata.Dependencies.Order(StringComparer.Ordinal))) return false;
            seen++;
        }
        return seen == expected.Count;
    }

    private static void PruneMissingCrates(SqliteConnection conn, SqliteTransaction tx, string repoRoot,
        string root, HashSet<string> discovered)
    {
        using var query = conn.CreateCommand();
        query.Transaction = tx;
        query.CommandText = "SELECT id, manifest_path FROM rust_crates";
        var stale = new List<long>();
        using (var reader = query.ExecuteReader())
            while (reader.Read())
            {
                var path = reader.GetString(1);
                var absolute = Path.GetFullPath(Path.Combine(repoRoot, path));
                if ((absolute == root || absolute.StartsWith(root + Path.DirectorySeparatorChar, StringComparison.Ordinal))
                    && !discovered.Contains(path)) stale.Add(reader.GetInt64(0));
            }
        foreach (var id in stale)
        {
            using var delete = conn.CreateCommand();
            delete.Transaction = tx;
            delete.CommandText = "DELETE FROM rust_dependencies WHERE crate_id = $id; DELETE FROM rust_crates WHERE id = $id";
            delete.Parameters.AddWithValue("$id", id);
            delete.ExecuteNonQuery();
        }
    }

    private static void PruneMissingRustFiles(SqliteConnection conn, SqliteTransaction tx, string repoRoot, string indexedRoot, HashSet<string> discovered)
    {
        using var query = conn.CreateCommand();
        query.Transaction = tx;
        query.CommandText = "SELECT id, path FROM files WHERE language = 'rust'";
        var stale = new List<long>();
        using (var reader = query.ExecuteReader())
        {
            while (reader.Read())
            {
                var path = reader.GetString(1);
                var absolute = Path.GetFullPath(Path.Combine(repoRoot, path));
                if ((absolute.StartsWith(indexedRoot + Path.DirectorySeparatorChar, StringComparison.Ordinal) || absolute == indexedRoot)
                    && !discovered.Contains(path)) stale.Add(reader.GetInt64(0));
            }
        }
        foreach (var id in stale)
        {
            DeleteFileScopedRows(conn, tx, id);
            using var delete = conn.CreateCommand();
            delete.Transaction = tx;
            delete.CommandText = "DELETE FROM files WHERE id = $id";
            delete.Parameters.AddWithValue("$id", id);
            delete.ExecuteNonQuery();
        }
    }

    private static bool IsExcludedPath(string root, string path)
    {
        var rel = Path.GetRelativePath(root, path);
        return rel.Split(Path.DirectorySeparatorChar).Any(seg => ExcludedDirs.Contains(seg));
    }

    private static (string? Name, List<string> Dependencies) ReadCargoMetadataFallback(string cargoTomlPath)
    {
        var text = File.ReadAllText(cargoTomlPath);
        string? name = null;
        var deps = new List<string>();
        var inPackage = false;
        var inDependencies = false;

        foreach (var raw in text.Split('\n'))
        {
            var line = raw.Trim();
            if (line.StartsWith("["))
            {
                inPackage = line.Equals("[package]", StringComparison.OrdinalIgnoreCase);
                inDependencies = line.Equals("[dependencies]", StringComparison.OrdinalIgnoreCase);
                continue;
            }

            if (inPackage && line.StartsWith("name"))
            {
                var split = line.Split('=', 2);
                if (split.Length == 2)
                {
                    name = split[1].Trim().Trim('"');
                }
            }

            if (inDependencies && line.Contains('='))
            {
                var depName = line.Split('=', 2)[0].Trim();
                if (!string.IsNullOrWhiteSpace(depName))
                {
                    deps.Add(depName);
                }
            }
        }

        return (name, deps.Distinct(StringComparer.Ordinal).ToList());
    }

    private static long UpsertFile(SqliteConnection conn, SqliteTransaction tx, string path, string hash)
    {
        using var cmd = conn.CreateCommand();
        cmd.Transaction = tx;
        cmd.CommandText = @"
INSERT INTO files(path, language, hash, indexed_at)
VALUES($path, 'rust', $hash, datetime('now'))
ON CONFLICT(path) DO UPDATE SET
  hash = excluded.hash,
  indexed_at = excluded.indexed_at,
  language = excluded.language
RETURNING id;
";
        cmd.Parameters.AddWithValue("$path", path);
        cmd.Parameters.AddWithValue("$hash", hash);
        return (long)(cmd.ExecuteScalar() ?? 0L);
    }

    private static void DeleteFileScopedRows(SqliteConnection conn, SqliteTransaction tx, long fileId)
    {
        foreach (var table in new[] { "symbols", "references_map", "edges" })
        {
            using var cmd = conn.CreateCommand();
            cmd.Transaction = tx;
            cmd.CommandText = $"DELETE FROM {table} WHERE file_id = $fileId;";
            cmd.Parameters.AddWithValue("$fileId", fileId);
            cmd.ExecuteNonQuery();
        }
    }

    private static long UpsertRustCrate(SqliteConnection conn, SqliteTransaction tx, string name, string manifestPath)
    {
        using var lookup = conn.CreateCommand();
        lookup.Transaction = tx;
        lookup.CommandText = "SELECT id FROM rust_crates WHERE manifest_path = $manifest LIMIT 1;";
        lookup.Parameters.AddWithValue("$manifest", manifestPath);
        var existing = lookup.ExecuteScalar();

        if (existing is long id)
        {
            using var update = conn.CreateCommand();
            update.Transaction = tx;
            update.CommandText = "UPDATE rust_crates SET name = $name WHERE id = $id;";
            update.Parameters.AddWithValue("$name", name);
            update.Parameters.AddWithValue("$id", id);
            update.ExecuteNonQuery();
            return id;
        }

        using var insert = conn.CreateCommand();
        insert.Transaction = tx;
        insert.CommandText = @"
INSERT INTO rust_crates(name, manifest_path, root_module)
VALUES($name, $manifest, NULL)
RETURNING id;
";
        insert.Parameters.AddWithValue("$name", name);
        insert.Parameters.AddWithValue("$manifest", manifestPath);
        return (long)(insert.ExecuteScalar() ?? 0L);
    }

    private static void DeleteRustDependencies(SqliteConnection conn, SqliteTransaction tx, long crateId)
    {
        using var cmd = conn.CreateCommand();
        cmd.Transaction = tx;
        cmd.CommandText = "DELETE FROM rust_dependencies WHERE crate_id = $crateId;";
        cmd.Parameters.AddWithValue("$crateId", crateId);
        cmd.ExecuteNonQuery();
    }

    private static void InsertRustDependency(SqliteConnection conn, SqliteTransaction tx, long crateId, string dependencyName, string dependencyKind, string? versionReq)
    {
        using var cmd = conn.CreateCommand();
        cmd.Transaction = tx;
        cmd.CommandText = @"
INSERT INTO rust_dependencies(crate_id, dependency_name, dependency_kind, version_req)
VALUES($crateId, $dep, $kind, $ver);
";
        cmd.Parameters.AddWithValue("$crateId", crateId);
        cmd.Parameters.AddWithValue("$dep", dependencyName);
        cmd.Parameters.AddWithValue("$kind", dependencyKind);
        cmd.Parameters.AddWithValue("$ver", (object?)versionReq ?? DBNull.Value);
        cmd.ExecuteNonQuery();
    }

    private static void InsertSymbol(SqliteConnection conn, SqliteTransaction tx, long fileId, RustSymbol symbol)
    {
        using var cmd = conn.CreateCommand();
        cmd.Transaction = tx;
        cmd.CommandText = @"
INSERT INTO symbols(file_id, name, full_name, kind, language, start_line, end_line, accessibility, parent_symbol)
VALUES($fileId, $name, $fullName, $kind, 'rust', $start, $end, $access, $parent);
";
        cmd.Parameters.AddWithValue("$fileId", fileId);
        cmd.Parameters.AddWithValue("$name", symbol.Name);
        cmd.Parameters.AddWithValue("$fullName", symbol.FullName);
        cmd.Parameters.AddWithValue("$kind", symbol.Kind);
        cmd.Parameters.AddWithValue("$start", symbol.StartLine);
        cmd.Parameters.AddWithValue("$end", symbol.EndLine);
        cmd.Parameters.AddWithValue("$access", (object?)symbol.Accessibility ?? DBNull.Value);
        cmd.Parameters.AddWithValue("$parent", (object?)symbol.ParentSymbol ?? DBNull.Value);
        cmd.ExecuteNonQuery();
    }

    private static void InsertReference(SqliteConnection conn, SqliteTransaction tx, long fileId, string symbolFullName, RustReference reference)
    {
        using var cmd = conn.CreateCommand();
        cmd.Transaction = tx;
        cmd.CommandText = @"
INSERT INTO references_map(symbol_full_name, referenced_from_symbol, file_id, line, column, reference_kind, reference_token)
VALUES($symbol, $from, $fileId, $line, $column, $kind, $token);
";
        cmd.Parameters.AddWithValue("$symbol", symbolFullName);
        cmd.Parameters.AddWithValue("$from", (object?)reference.ReferencedFromSymbol ?? DBNull.Value);
        cmd.Parameters.AddWithValue("$fileId", fileId);
        cmd.Parameters.AddWithValue("$line", reference.Line);
        cmd.Parameters.AddWithValue("$column", reference.Column);
        cmd.Parameters.AddWithValue("$kind", reference.ReferenceKind);
        cmd.Parameters.AddWithValue("$token", reference.SymbolToken);
        cmd.ExecuteNonQuery();
    }

    private static void InsertEdge(SqliteConnection conn, SqliteTransaction tx, long fileId, string from, string to, string edgeType)
    {
        using var cmd = conn.CreateCommand();
        cmd.Transaction = tx;
        cmd.CommandText = @"
INSERT INTO edges(from_symbol, to_symbol, edge_type, file_id)
VALUES($from, $to, $edgeType, $fileId);
";
        cmd.Parameters.AddWithValue("$from", from);
        cmd.Parameters.AddWithValue("$to", to);
        cmd.Parameters.AddWithValue("$edgeType", edgeType);
        cmd.Parameters.AddWithValue("$fileId", fileId);
        cmd.ExecuteNonQuery();
    }

}
