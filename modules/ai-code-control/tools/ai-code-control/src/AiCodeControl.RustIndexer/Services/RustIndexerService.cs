using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;
using AiCodeControl.RustIndexer.Models;
using Microsoft.Data.Sqlite;

namespace AiCodeControl.RustIndexer.Services;

public sealed class RustIndexerService
{
    private static readonly Regex FnRegex = new("^(?<indent>\\s*)(?<vis>pub\\s+)?fn\\s+(?<name>[A-Za-z_][A-Za-z0-9_]*)", RegexOptions.Compiled);
    private static readonly Regex StructRegex = new("^(?<indent>\\s*)(?<vis>pub\\s+)?struct\\s+(?<name>[A-Za-z_][A-Za-z0-9_]*)", RegexOptions.Compiled);
    private static readonly Regex EnumRegex = new("^(?<indent>\\s*)(?<vis>pub\\s+)?enum\\s+(?<name>[A-Za-z_][A-Za-z0-9_]*)", RegexOptions.Compiled);
    private static readonly Regex TraitRegex = new("^(?<indent>\\s*)(?<vis>pub\\s+)?trait\\s+(?<name>[A-Za-z_][A-Za-z0-9_]*)", RegexOptions.Compiled);
    private static readonly Regex ImplRegex = new("^(?<indent>\\s*)impl(\\s*<[^>]+>)?\\s+(?<name>[A-Za-z_][A-Za-z0-9_:<>]*)", RegexOptions.Compiled);
    private static readonly Regex CallRegex = new("\\b(?<name>[A-Za-z_][A-Za-z0-9_]*)\\s*\\(", RegexOptions.Compiled);

    private static readonly HashSet<string> ExcludedDirs = new(StringComparer.OrdinalIgnoreCase)
    {
        "target", ".git", "node_modules", "bin", "obj"
    };

    private static readonly HashSet<string> CallExcludes = new(StringComparer.Ordinal)
    {
        "if", "for", "while", "loop", "match", "println", "format", "vec", "Some", "Ok", "Err"
    };

    public RustIndexResult Index(string repoRoot, string indexPath, string dbPath)
    {
        var root = Path.GetFullPath(Path.Combine(repoRoot, indexPath));
        var cargoTomls = Directory.EnumerateFiles(root, "Cargo.toml", SearchOption.AllDirectories)
            .Where(p => !IsExcludedPath(root, p))
            .ToList();

        var rsFiles = Directory.EnumerateFiles(root, "*.rs", SearchOption.AllDirectories)
            .Where(p => !IsExcludedPath(root, p))
            .ToList();

        var parsed = rsFiles.Select(f => ParseFile(repoRoot, f)).ToList();

        using var conn = new SqliteConnection($"Data Source={dbPath}");
        conn.Open();
        using var tx = conn.BeginTransaction();

        var symbolsBySimpleName = new Dictionary<string, List<string>>(StringComparer.Ordinal);
        foreach (var f in parsed)
        {
            foreach (var s in f.Symbols)
            {
                if (!symbolsBySimpleName.TryGetValue(s.Name, out var list))
                {
                    list = new List<string>();
                    symbolsBySimpleName[s.Name] = list;
                }

                list.Add(s.FullName);
            }
        }

        var cratesIndexed = 0;
        var dependenciesIndexed = 0;
        foreach (var cargo in cargoTomls)
        {
            var (crateName, deps) = ReadCargoMetadataFallback(cargo);
            if (string.IsNullOrWhiteSpace(crateName))
            {
                continue;
            }

            var crateId = UpsertRustCrate(conn, tx, crateName!, Path.GetRelativePath(repoRoot, cargo).Replace('\\', '/'));
            DeleteRustDependencies(conn, tx, crateId);
            foreach (var dep in deps)
            {
                InsertRustDependency(conn, tx, crateId, dep, "normal", null);
                dependenciesIndexed++;
            }

            cratesIndexed++;
        }

        var filesIndexed = 0;
        var symbolsIndexed = 0;
        var refsIndexed = 0;
        var edgesIndexed = 0;

        foreach (var f in parsed)
        {
            var fileId = UpsertFile(conn, tx, f.RelativePath, f.Hash);
            DeleteFileScopedRows(conn, tx, fileId);

            foreach (var s in f.Symbols)
            {
                InsertSymbol(conn, tx, fileId, s);
                symbolsIndexed++;
            }

            foreach (var r in f.References)
            {
                var resolved = ResolveReference(r.SymbolToken, symbolsBySimpleName);
                InsertReference(conn, tx, fileId, resolved, r);
                refsIndexed++;

                if (!string.IsNullOrWhiteSpace(r.ReferencedFromSymbol))
                {
                    InsertEdge(conn, tx, fileId, r.ReferencedFromSymbol!, resolved, "calls");
                    edgesIndexed++;
                }
            }

            filesIndexed++;
        }

        tx.Commit();
        return new RustIndexResult(cratesIndexed, dependenciesIndexed, filesIndexed, symbolsIndexed, refsIndexed, edgesIndexed);
    }

    private static RustFileIndex ParseFile(string repoRoot, string file)
    {
        var lines = File.ReadAllLines(file);
        var symbols = new List<RustSymbol>();
        var references = new List<RustReference>();
        var moduleName = ToRustModuleName(repoRoot, file);

        var scopeStack = new Stack<(int BraceDepth, string FullName, string Kind)>();
        var braceDepth = 0;

        for (var i = 0; i < lines.Length; i++)
        {
            var line = lines[i];
            var trimmed = line.TrimStart();

            while (scopeStack.Count > 0 && braceDepth < scopeStack.Peek().BraceDepth)
            {
                scopeStack.Pop();
            }

            if (TryMatch(line, StructRegex, out var structName, out var structVis))
            {
                AddSymbol(symbols, scopeStack, moduleName, structName, "struct", i + 1, structVis);
            }
            else if (TryMatch(line, EnumRegex, out var enumName, out var enumVis))
            {
                AddSymbol(symbols, scopeStack, moduleName, enumName, "enum", i + 1, enumVis);
            }
            else if (TryMatch(line, TraitRegex, out var traitName, out var traitVis))
            {
                AddSymbol(symbols, scopeStack, moduleName, traitName, "trait", i + 1, traitVis);
            }
            else if (TryMatch(line, FnRegex, out var fnName, out var fnVis))
            {
                var kind = scopeStack.Count > 0 && scopeStack.Peek().Kind == "impl" ? "method" : "function";
                AddSymbol(symbols, scopeStack, moduleName, fnName, kind, i + 1, fnVis);
            }
            else
            {
                var implMatch = ImplRegex.Match(line);
                if (implMatch.Success)
                {
                    var implName = implMatch.Groups["name"].Value;
                    var parent = scopeStack.Count > 0 ? scopeStack.Peek().FullName : moduleName;
                    var full = parent + "::impl(" + implName + ")";
                    symbols.Add(new RustSymbol("impl", full, "impl", i + 1, i + 1, parent));
                    scopeStack.Push((braceDepth + 1, full, "impl"));
                }
            }

            foreach (Match m in CallRegex.Matches(line))
            {
                var token = m.Groups["name"].Value;
                if (CallExcludes.Contains(token))
                {
                    continue;
                }

                var from = scopeStack.Count > 0 ? scopeStack.Peek().FullName : moduleName;
                references.Add(new RustReference(token, from, i + 1, m.Groups["name"].Index + 1, "call"));
            }

            braceDepth += CountChar(trimmed, '{');
            braceDepth -= CountChar(trimmed, '}');
            if (braceDepth < 0)
            {
                braceDepth = 0;
            }
        }

        var hash = Sha256Hex(File.ReadAllText(file));
        var relativePath = Path.GetRelativePath(repoRoot, file).Replace('\\', '/');
        return new RustFileIndex(relativePath, hash, symbols, references);
    }

    private static void AddSymbol(List<RustSymbol> symbols, Stack<(int BraceDepth, string FullName, string Kind)> stack, string moduleName, string name, string kind, int line, string? visibility)
    {
        var parent = stack.Count > 0 ? stack.Peek().FullName : moduleName;
        var full = parent + "::" + name;
        symbols.Add(new RustSymbol(name, full, kind, line, line, parent, visibility));
        stack.Push((stack.Count > 0 ? stack.Peek().BraceDepth + 1 : 1, full, kind == "method" ? "function" : kind));
    }

    private static bool TryMatch(string line, Regex regex, out string name, out string? visibility)
    {
        var match = regex.Match(line);
        if (match.Success)
        {
            name = match.Groups["name"].Value;
            visibility = string.IsNullOrWhiteSpace(match.Groups["vis"].Value) ? null : "public";
            return true;
        }

        name = string.Empty;
        visibility = null;
        return false;
    }

    private static bool IsExcludedPath(string root, string path)
    {
        var rel = Path.GetRelativePath(root, path);
        return rel.Split(Path.DirectorySeparatorChar).Any(seg => ExcludedDirs.Contains(seg));
    }

    private static string ToRustModuleName(string repoRoot, string file)
    {
        var rel = Path.GetRelativePath(repoRoot, file).Replace('\\', '/');
        if (rel.EndsWith(".rs", StringComparison.OrdinalIgnoreCase)) rel = rel[..^3];
        rel = rel.Replace("/mod", "");
        return rel.Replace('/', ':').Replace("::", ":");
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

    private static int CountChar(string s, char c)
    {
        var n = 0;
        foreach (var ch in s)
        {
            if (ch == c) n++;
        }
        return n;
    }

    private static string Sha256Hex(string content)
    {
        var bytes = SHA256.HashData(Encoding.UTF8.GetBytes(content));
        return Convert.ToHexString(bytes).ToLowerInvariant();
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
INSERT INTO references_map(symbol_full_name, referenced_from_symbol, file_id, line, column, reference_kind)
VALUES($symbol, $from, $fileId, $line, $column, $kind);
";
        cmd.Parameters.AddWithValue("$symbol", symbolFullName);
        cmd.Parameters.AddWithValue("$from", (object?)reference.ReferencedFromSymbol ?? DBNull.Value);
        cmd.Parameters.AddWithValue("$fileId", fileId);
        cmd.Parameters.AddWithValue("$line", reference.Line);
        cmd.Parameters.AddWithValue("$column", reference.Column);
        cmd.Parameters.AddWithValue("$kind", reference.ReferenceKind);
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

    private static string ResolveReference(string token, Dictionary<string, List<string>> symbolsBySimpleName)
    {
        if (symbolsBySimpleName.TryGetValue(token, out var names) && names.Count == 1)
        {
            return names[0];
        }

        return token;
    }
}

