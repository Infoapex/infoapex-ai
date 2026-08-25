using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;
using AiCodeControl.PythonIndexer.Models;
using Microsoft.Data.Sqlite;

namespace AiCodeControl.PythonIndexer.Services;

public sealed class PythonIndexerService
{
    private static readonly Regex ClassRegex = new("^(?<indent>\\s*)class\\s+(?<name>[A-Za-z_][A-Za-z0-9_]*)", RegexOptions.Compiled);
    private static readonly Regex DefRegex = new("^(?<indent>\\s*)(async\\s+)?def\\s+(?<name>[A-Za-z_][A-Za-z0-9_]*)\\s*\\(", RegexOptions.Compiled);
    private static readonly Regex ImportRegex = new("^(?<indent>\\s*)import\\s+(?<module>[^#]+)", RegexOptions.Compiled);
    private static readonly Regex FromImportRegex = new("^(?<indent>\\s*)from\\s+(?<module>[A-Za-z0-9_\\.]+)\\s+import\\s+(?<names>[^#]+)", RegexOptions.Compiled);
    private static readonly Regex CallRegex = new("\\b(?<name>[A-Za-z_][A-Za-z0-9_]*)\\s*\\(", RegexOptions.Compiled);

    private static readonly HashSet<string> ExcludedDirs = new(StringComparer.OrdinalIgnoreCase)
    {
        ".git", ".venv", "venv", "__pycache__", ".pytest_cache", ".mypy_cache", ".ruff_cache", "node_modules", "target", "bin", "obj"
    };

    private static readonly HashSet<string> CallExcludes = new(StringComparer.Ordinal)
    {
        "if", "for", "while", "return", "print", "len", "range", "dict", "list", "set", "tuple", "str", "int", "float"
    };

    public PythonIndexResult Index(string repoRoot, string indexPath, string dbPath)
    {
        var fullIndexPath = Path.GetFullPath(Path.Combine(repoRoot, indexPath));
        var files = EnumeratePythonFiles(fullIndexPath).ToList();

        var parsed = new List<PythonFileIndex>();
        foreach (var file in files)
        {
            parsed.Add(ParseFile(repoRoot, file));
        }

        using var connection = new SqliteConnection($"Data Source={dbPath}");
        connection.Open();

        using var tx = connection.BeginTransaction();

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

        var filesIndexed = 0;
        var symbolsIndexed = 0;
        var refsIndexed = 0;
        var edgesIndexed = 0;
        var importsIndexed = 0;

        foreach (var f in parsed)
        {
            var fileId = UpsertFile(connection, tx, f.RelativePath, f.Hash);
            DeleteFileScopedRows(connection, tx, fileId);

            foreach (var s in f.Symbols)
            {
                InsertSymbol(connection, tx, fileId, s);
                symbolsIndexed++;
            }

            foreach (var i in f.Imports)
            {
                InsertImport(connection, tx, fileId, i);
                importsIndexed++;
            }

            foreach (var r in f.References)
            {
                var resolved = ResolveReference(r.SymbolToken, symbolsBySimpleName);
                InsertReference(connection, tx, fileId, resolved, r);
                refsIndexed++;

                if (!string.IsNullOrWhiteSpace(r.ReferencedFromSymbol))
                {
                    InsertEdge(connection, tx, fileId, r.ReferencedFromSymbol!, resolved, "calls");
                    edgesIndexed++;
                }
            }

            filesIndexed++;
        }

        tx.Commit();
        return new PythonIndexResult(filesIndexed, symbolsIndexed, refsIndexed, edgesIndexed, importsIndexed);
    }

    private static IEnumerable<string> EnumeratePythonFiles(string root)
    {
        foreach (var file in Directory.EnumerateFiles(root, "*.py", SearchOption.AllDirectories))
        {
            var relative = Path.GetRelativePath(root, file);
            if (relative.Split(Path.DirectorySeparatorChar).Any(segment => ExcludedDirs.Contains(segment)))
            {
                continue;
            }

            yield return file;
        }
    }

    private static PythonFileIndex ParseFile(string repoRoot, string file)
    {
        var lines = File.ReadAllLines(file);
        var symbols = new List<IndexedSymbol>();
        var references = new List<IndexedReference>();
        var imports = new List<IndexedImport>();
        var moduleName = ToModuleName(repoRoot, file);

        var scopeStack = new Stack<(int Indent, string FullName, string Kind)>();

        for (var i = 0; i < lines.Length; i++)
        {
            var line = lines[i];
            var indent = CountIndent(line);

            while (scopeStack.Count > 0 && indent <= scopeStack.Peek().Indent)
            {
                scopeStack.Pop();
            }

            var classMatch = ClassRegex.Match(line);
            if (classMatch.Success)
            {
                var name = classMatch.Groups["name"].Value;
                var parent = scopeStack.Count > 0 ? scopeStack.Peek().FullName : moduleName;
                var full = parent + "." + name;
                var parentSymbol = scopeStack.Count > 0 ? scopeStack.Peek().FullName : moduleName;
                symbols.Add(new IndexedSymbol(name, full, "class", i + 1, i + 1, parentSymbol));
                scopeStack.Push((indent, full, "class"));
                continue;
            }

            var defMatch = DefRegex.Match(line);
            if (defMatch.Success)
            {
                var name = defMatch.Groups["name"].Value;
                var parent = scopeStack.Count > 0 ? scopeStack.Peek().FullName : moduleName;
                var kind = scopeStack.Count > 0 && scopeStack.Peek().Kind == "class" ? "method" : "function";
                var full = parent + "." + name;
                var parentSymbol = scopeStack.Count > 0 ? scopeStack.Peek().FullName : moduleName;
                symbols.Add(new IndexedSymbol(name, full, kind, i + 1, i + 1, parentSymbol));
                scopeStack.Push((indent, full, kind));
                continue;
            }

            var importMatch = ImportRegex.Match(line);
            if (importMatch.Success)
            {
                var modules = importMatch.Groups["module"].Value.Split(',');
                foreach (var partRaw in modules)
                {
                    var part = partRaw.Trim();
                    if (string.IsNullOrWhiteSpace(part))
                    {
                        continue;
                    }

                    var aliasSplit = part.Split(" as ", StringSplitOptions.TrimEntries);
                    imports.Add(new IndexedImport(aliasSplit[0], null, aliasSplit.Length > 1 ? aliasSplit[1] : null, i + 1));
                }
            }

            var fromImportMatch = FromImportRegex.Match(line);
            if (fromImportMatch.Success)
            {
                var module = fromImportMatch.Groups["module"].Value.Trim();
                var names = fromImportMatch.Groups["names"].Value.Split(',');
                foreach (var nameRaw in names)
                {
                    var namePart = nameRaw.Trim();
                    if (string.IsNullOrWhiteSpace(namePart))
                    {
                        continue;
                    }

                    var aliasSplit = namePart.Split(" as ", StringSplitOptions.TrimEntries);
                    imports.Add(new IndexedImport(module, aliasSplit[0], aliasSplit.Length > 1 ? aliasSplit[1] : null, i + 1));
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
                references.Add(new IndexedReference(token, from, i + 1, m.Groups["name"].Index + 1, "call"));
            }
        }

        var hash = Sha256Hex(File.ReadAllText(file));
        var relativePath = Path.GetRelativePath(repoRoot, file).Replace('\\', '/');
        return new PythonFileIndex(relativePath, hash, symbols, references, imports);
    }

    private static string ToModuleName(string repoRoot, string file)
    {
        var relative = Path.GetRelativePath(repoRoot, file).Replace('\\', '/');
        if (relative.EndsWith(".py", StringComparison.OrdinalIgnoreCase))
        {
            relative = relative[..^3];
        }

        if (relative.EndsWith("/__init__", StringComparison.OrdinalIgnoreCase))
        {
            relative = relative[..^9];
        }

        return relative.Replace('/', '.');
    }

    private static int CountIndent(string line)
    {
        var count = 0;
        foreach (var ch in line)
        {
            if (ch == ' ')
            {
                count++;
            }
            else if (ch == '\t')
            {
                count += 4;
            }
            else
            {
                break;
            }
        }

        return count;
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
VALUES($path, 'python', $hash, datetime('now'))
ON CONFLICT(path) DO UPDATE SET
  hash = excluded.hash,
  indexed_at = excluded.indexed_at
RETURNING id;
";
        cmd.Parameters.AddWithValue("$path", path);
        cmd.Parameters.AddWithValue("$hash", hash);
        return (long)(cmd.ExecuteScalar() ?? 0L);
    }

    private static void DeleteFileScopedRows(SqliteConnection conn, SqliteTransaction tx, long fileId)
    {
        foreach (var table in new[] { "symbols", "references_map", "python_imports", "edges" })
        {
            using var cmd = conn.CreateCommand();
            cmd.Transaction = tx;
            cmd.CommandText = $"DELETE FROM {table} WHERE file_id = $fileId;";
            cmd.Parameters.AddWithValue("$fileId", fileId);
            cmd.ExecuteNonQuery();
        }
    }

    private static void InsertSymbol(SqliteConnection conn, SqliteTransaction tx, long fileId, IndexedSymbol symbol)
    {
        using var cmd = conn.CreateCommand();
        cmd.Transaction = tx;
        cmd.CommandText = @"
INSERT INTO symbols(file_id, name, full_name, kind, language, start_line, end_line, accessibility, parent_symbol)
VALUES($fileId, $name, $fullName, $kind, 'python', $start, $end, $access, $parent);
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

    private static void InsertImport(SqliteConnection conn, SqliteTransaction tx, long fileId, IndexedImport import)
    {
        using var cmd = conn.CreateCommand();
        cmd.Transaction = tx;
        cmd.CommandText = @"
INSERT INTO python_imports(file_id, module, imported_name, alias, line)
VALUES($fileId, $module, $imported, $alias, $line);
";
        cmd.Parameters.AddWithValue("$fileId", fileId);
        cmd.Parameters.AddWithValue("$module", import.Module);
        cmd.Parameters.AddWithValue("$imported", (object?)import.ImportedName ?? DBNull.Value);
        cmd.Parameters.AddWithValue("$alias", (object?)import.Alias ?? DBNull.Value);
        cmd.Parameters.AddWithValue("$line", import.Line);
        cmd.ExecuteNonQuery();
    }

    private static void InsertReference(SqliteConnection conn, SqliteTransaction tx, long fileId, string symbolFullName, IndexedReference reference)
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
