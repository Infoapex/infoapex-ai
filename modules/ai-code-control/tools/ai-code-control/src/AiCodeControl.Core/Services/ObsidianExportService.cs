using System.Diagnostics;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;
using Microsoft.Data.Sqlite;

namespace AiCodeControl.Core.Services;

/// <summary>
/// Projects the rebuildable SQLite code graph into a small, human-oriented
/// Obsidian vault. The SQLite database and source code remain authoritative.
/// </summary>
public sealed class ObsidianExportService
{
    private static readonly Regex UnsafeSlugCharacters = new("[^a-z0-9]+", RegexOptions.Compiled | RegexOptions.IgnoreCase);

    public ObsidianExportResult Export(ObsidianExportOptions options)
    {
        var repositoryRoot = Path.GetFullPath(options.RepositoryRoot);
        if (!Directory.Exists(repositoryRoot))
            throw new DirectoryNotFoundException($"Repository root does not exist: {repositoryRoot}");

        var scopeRoot = ResolveInside(repositoryRoot, options.ScopePath, "Scope");
        if (!Directory.Exists(scopeRoot))
            throw new DirectoryNotFoundException($"Scope path does not exist: {options.ScopePath}");

        var outputRoot = Path.GetFullPath(Path.Combine(repositoryRoot, options.OutputPath));
        Directory.CreateDirectory(outputRoot);
        var databasePath = Path.GetFullPath(options.DatabasePath);
        if (!File.Exists(databasePath))
            throw new FileNotFoundException("Code graph database was not found. Run index-code or refresh first.", databasePath);

        var graph = ReadGraph(databasePath, repositoryRoot, scopeRoot);
        var generatedAt = DateTimeOffset.UtcNow;
        var exportRoot = new ExportContext(repositoryRoot, outputRoot, graph, generatedAt,
            options.IncludeSymbols, Math.Clamp(options.MaxSymbols, 1, 10_000));
        var selectedSymbols = options.IncludeSymbols
            ? graph.Symbols
                .GroupBy(s => s.FullName, StringComparer.Ordinal)
                .Select(group => group.OrderBy(s => s.FileId).ThenBy(s => s.StartLine).First())
                .Where(s => graph.FilesById.ContainsKey(s.FileId))
                .OrderByDescending(s => string.Equals(s.Accessibility, "public", StringComparison.OrdinalIgnoreCase))
                .ThenBy(s => s.FullName, StringComparer.Ordinal)
                .Take(exportRoot.MaxSymbols)
                .ToList()
            : new List<CodeSymbol>();
        foreach (var symbol in selectedSymbols)
            exportRoot.IncludedSymbolNames.Add(symbol.FullName);

        WriteIndex(exportRoot);
        foreach (var module in graph.Modules)
            WriteModule(exportRoot, module);
        foreach (var file in graph.Files)
            WriteFileNote(exportRoot, file);

        foreach (var symbol in selectedSymbols)
            WriteSymbol(exportRoot, symbol);

        WriteCanvas(exportRoot);
        WriteManifest(exportRoot);

        return new ObsidianExportResult(
            "ok",
            outputRoot,
            graph.Files.Count,
            graph.Modules.Count,
            selectedSymbols.Count,
            graph.Edges.Count,
            graph.Branch,
            graph.Commit,
            graph.WorkingTreeDirty,
            generatedAt);
    }

    private static CodeGraph ReadGraph(string databasePath, string repositoryRoot, string scopeRoot)
    {
        using var connection = new SqliteConnection($"Data Source={databasePath}");
        connection.Open();

        var scopeRelative = Path.GetRelativePath(repositoryRoot, scopeRoot).Replace('\\', '/');
        var files = new List<CodeFile>();
        using (var command = connection.CreateCommand())
        {
            command.CommandText = @"
SELECT id, path, language, hash, indexed_at
FROM files
WHERE language IN ('csharp','typescript','javascript','sql','python','rust')
ORDER BY path;";
            using var reader = command.ExecuteReader();
            while (reader.Read())
            {
                var path = reader.GetString(1).Replace('\\', '/');
                if (!IsInScope(path, scopeRelative))
                    continue;
                files.Add(new CodeFile(reader.GetInt64(0), path, reader.GetString(2), reader.GetString(3), reader.GetString(4)));
            }
        }

        var fileIds = files.Select(file => file.Id).ToHashSet();
        var symbols = new List<CodeSymbol>();
        using (var command = connection.CreateCommand())
        {
            command.CommandText = @"
SELECT id, file_id, name, full_name, kind, language, start_line, end_line, accessibility, parent_symbol
FROM symbols
ORDER BY full_name;";
            using var reader = command.ExecuteReader();
            while (reader.Read())
            {
                var fileId = reader.GetInt64(1);
                if (!fileIds.Contains(fileId))
                    continue;
                symbols.Add(new CodeSymbol(
                    reader.GetInt64(0), fileId, reader.GetString(2), reader.GetString(3), reader.GetString(4),
                    reader.GetString(5), reader.GetInt32(6), reader.GetInt32(7),
                    reader.IsDBNull(8) ? null : reader.GetString(8),
                    reader.IsDBNull(9) ? null : reader.GetString(9)));
            }
        }

        var symbolNames = symbols.Select(symbol => symbol.FullName).ToHashSet(StringComparer.Ordinal);
        var symbolFileIds = symbols
            .GroupBy(symbol => symbol.FullName, StringComparer.Ordinal)
            .ToDictionary(group => group.Key, group => group.OrderBy(symbol => symbol.FileId).ThenBy(symbol => symbol.StartLine).First().FileId, StringComparer.Ordinal);
        var edges = new List<CodeEdge>();
        using (var command = connection.CreateCommand())
        {
            command.CommandText = @"
SELECT from_symbol, to_symbol, edge_type
FROM edges
WHERE from_symbol IS NOT NULL AND to_symbol IS NOT NULL
ORDER BY from_symbol, to_symbol, edge_type;";
            using var reader = command.ExecuteReader();
            while (reader.Read())
            {
                var from = reader.GetString(0);
                var to = reader.GetString(1);
                if (!symbolNames.Contains(from) || !symbolNames.Contains(to))
                    continue;
                edges.Add(new CodeEdge(from, to, reader.GetString(2), symbolFileIds[from], symbolFileIds[to]));
            }
        }

        var latestRun = ReadLatestRun(connection, repositoryRoot);
        var workingTreeDirty = RunGit(repositoryRoot, "status", "--porcelain") is { Length: > 0 };
        var filesById = files.ToDictionary(file => file.Id);
        var modules = files
            .GroupBy(file => ModuleKey(file.Path), StringComparer.OrdinalIgnoreCase)
            .Select(group => new CodeModule(group.Key, group.OrderBy(file => file.Path, StringComparer.OrdinalIgnoreCase).ToList()))
            .OrderBy(module => module.Key, StringComparer.OrdinalIgnoreCase)
            .ToList();

        return new CodeGraph(files, filesById, symbols, edges, modules, latestRun.Branch, latestRun.Commit, workingTreeDirty)
        {
            Scope = scopeRelative is "." or "" ? "." : scopeRelative
        };
    }

    private static (string? Branch, string? Commit) ReadLatestRun(SqliteConnection connection, string repositoryRoot)
    {
        using var command = connection.CreateCommand();
        command.CommandText = @"
SELECT branch, git_commit
FROM code_index_runs
ORDER BY id DESC
LIMIT 1;";
        using var reader = command.ExecuteReader();
        if (reader.Read())
            return (reader.IsDBNull(0) ? null : reader.GetString(0), reader.IsDBNull(1) ? null : reader.GetString(1));
        return (RunGit(repositoryRoot, "branch", "--show-current"), RunGit(repositoryRoot, "rev-parse", "HEAD"));
    }

    private static void WriteIndex(ExportContext context)
    {
        var builder = new StringBuilder();
        AppendFrontmatter(builder, new Dictionary<string, string?>
        {
            ["type"] = "code-map",
            ["source_of_truth"] = "code-and-sqlite-index",
            ["source_commit"] = context.Graph.Commit,
            ["source_branch"] = context.Graph.Branch,
            ["working_tree_dirty"] = context.Graph.WorkingTreeDirty.ToString().ToLowerInvariant(),
            ["generated_at"] = context.GeneratedAt.ToString("O"),
            ["scope"] = context.Graph.Scope
        });
        builder.AppendLine("# Code map");
        builder.AppendLine();
        builder.AppendLine("> Export generat de `ai-code-control`. Codul, contractele și indexul SQLite rămân sursele de adevăr; aceste note sunt o proiecție pentru navigare în Obsidian.");
        builder.AppendLine();
        builder.AppendLine($"- Commit indexat: `{context.Graph.Commit ?? "necunoscut"}`");
        builder.AppendLine($"- Branch: `{context.Graph.Branch ?? "necunoscut"}`");
        builder.AppendLine($"- Working tree: **{(context.Graph.WorkingTreeDirty ? "modificat" : "curat")}** la export");
        builder.AppendLine($"- Fișiere: **{context.Graph.Files.Count}**");
        builder.AppendLine($"- Module/domenii: **{context.Graph.Modules.Count}**");
        builder.AppendLine($"- Muchii de cod: **{context.Graph.Edges.Count}**");
        builder.AppendLine();
        builder.AppendLine("## Module și domenii");
        builder.AppendLine();
        foreach (var module in context.Graph.Modules)
            builder.AppendLine($"- [[modules/{Slug(module.Key)}|{module.Key}]] ({module.Files.Count} fișiere)");

        builder.AppendLine();
        builder.AppendLine("## Cum se citește harta");
        builder.AppendLine();
        builder.AppendLine("- Graph View arată legăturile dintre notele generate.");
        builder.AppendLine("- Canvas-ul `canvases/code-map.canvas` oferă o vedere de ansamblu pe module.");
        builder.AppendLine("- Notele de simbol sunt generate numai cu `--include-symbols`, pentru a evita zgomotul în vault.");
        builder.AppendLine("- Pentru o actualizare fidelă, rulează întâi `refresh`, apoi `obsidian-export`.");
        builder.AppendLine();
        builder.AppendLine("## Diagramă module");
        builder.AppendLine();
        builder.AppendLine("```mermaid");
        builder.AppendLine("flowchart LR");
        for (var index = 0; index < context.Graph.Modules.Count; index++)
            builder.AppendLine($"    M{index}[\"{EscapeMermaid(context.Graph.Modules[index].Key)}\"]");
        foreach (var dependency in ModuleDependencies(context.Graph))
        {
            var from = context.Graph.Modules.FindIndex(module => string.Equals(module.Key, dependency.From, StringComparison.OrdinalIgnoreCase));
            var to = context.Graph.Modules.FindIndex(module => string.Equals(module.Key, dependency.To, StringComparison.OrdinalIgnoreCase));
            if (from >= 0 && to >= 0)
                builder.AppendLine($"    M{from} -->|{dependency.Count}| M{to}");
        }
        builder.AppendLine("```");
        WriteText(Path.Combine(context.OutputRoot, "index.md"), builder.ToString());
    }

    private static void WriteModule(ExportContext context, CodeModule module)
    {
        var builder = new StringBuilder();
        AppendFrontmatter(builder, new Dictionary<string, string?>
        {
            ["type"] = "code-module",
            ["module"] = module.Key,
            ["source_commit"] = context.Graph.Commit,
            ["working_tree_dirty"] = context.Graph.WorkingTreeDirty.ToString().ToLowerInvariant(),
            ["generated_at"] = context.GeneratedAt.ToString("O")
        });
        builder.AppendLine($"# {module.Key}");
        builder.AppendLine();
        builder.AppendLine($"- Fișiere: **{module.Files.Count}**");
        builder.AppendLine($"- [[index|Înapoi la code map]]");
        builder.AppendLine();
        builder.AppendLine("## Fișiere");
        builder.AppendLine();
        foreach (var file in module.Files)
            builder.AppendLine($"- [[files/{Slug(file.Path)}|{file.Path}]] ({file.Language}, `{file.Hash[..Math.Min(12, file.Hash.Length)]}`)");

        var dependencies = ModuleDependencies(context.Graph)
            .Where(edge => string.Equals(edge.From, module.Key, StringComparison.OrdinalIgnoreCase));
        builder.AppendLine();
        builder.AppendLine("## Dependențe de cod");
        builder.AppendLine();
        foreach (var dependency in dependencies)
            builder.AppendLine($"- [[modules/{Slug(dependency.To)}|{dependency.To}]] ({dependency.Count} muchii)");
        if (!dependencies.Any())
            builder.AppendLine("- Nicio dependență între module detectată în indexul curent.");

        WriteText(Path.Combine(context.OutputRoot, "modules", $"{Slug(module.Key)}.md"), builder.ToString());
    }

    private static void WriteFileNote(ExportContext context, CodeFile file)
    {
        var builder = new StringBuilder();
        AppendFrontmatter(builder, new Dictionary<string, string?>
        {
            ["type"] = "code-file",
            ["source_path"] = file.Path,
            ["language"] = file.Language,
            ["source_hash"] = file.Hash,
            ["source_commit"] = context.Graph.Commit,
            ["working_tree_dirty"] = context.Graph.WorkingTreeDirty.ToString().ToLowerInvariant(),
            ["generated_at"] = context.GeneratedAt.ToString("O")
        });
        builder.AppendLine($"# `{file.Path}`");
        builder.AppendLine();
        builder.AppendLine($"- Modul: [[modules/{Slug(ModuleKey(file.Path))}|{ModuleKey(file.Path)}]]");
        builder.AppendLine($"- Limbaj: `{file.Language}`");
        builder.AppendLine($"- Hash: `{file.Hash}`");
        builder.AppendLine();
        builder.AppendLine("## Simboluri");
        builder.AppendLine();
        var symbols = context.Graph.Symbols.Where(symbol => symbol.FileId == file.Id).OrderBy(symbol => symbol.StartLine).ThenBy(symbol => symbol.FullName, StringComparer.Ordinal).ToList();
        foreach (var symbol in symbols)
        {
            var symbolLink = context.IncludedSymbolNames.Contains(symbol.FullName)
                ? $"[[symbols/{Slug(symbol.FullName)}|{symbol.FullName}]]"
                : $"`{symbol.FullName}`";
            builder.AppendLine($"- {symbolLink} — {symbol.Kind}, linii {symbol.StartLine}–{symbol.EndLine}");
        }
        if (symbols.Count == 0)
            builder.AppendLine("- Niciun simbol în indexul curent.");

        builder.AppendLine();
        builder.AppendLine("## Navigare");
        builder.AppendLine();
        builder.AppendLine($"- Sursă: `{file.Path}`");
        builder.AppendLine("- [[index|Înapoi la code map]]");
        WriteText(Path.Combine(context.OutputRoot, "files", $"{Slug(file.Path)}.md"), builder.ToString());
    }

    private static void WriteSymbol(ExportContext context, CodeSymbol symbol)
    {
        context.IncludedSymbolNames.Add(symbol.FullName);
        var file = context.Graph.FilesById[symbol.FileId];
        var builder = new StringBuilder();
        AppendFrontmatter(builder, new Dictionary<string, string?>
        {
            ["type"] = "code-symbol",
            ["symbol"] = symbol.FullName,
            ["kind"] = symbol.Kind,
            ["source_path"] = file.Path,
            ["source_commit"] = context.Graph.Commit,
            ["working_tree_dirty"] = context.Graph.WorkingTreeDirty.ToString().ToLowerInvariant(),
            ["generated_at"] = context.GeneratedAt.ToString("O")
        });
        builder.AppendLine($"# `{symbol.FullName}`");
        builder.AppendLine();
        builder.AppendLine($"- Fișier: [[files/{Slug(file.Path)}|{file.Path}]]");
        builder.AppendLine($"- Modul: [[modules/{Slug(ModuleKey(file.Path))}|{ModuleKey(file.Path)}]]");
        builder.AppendLine($"- Tip: `{symbol.Kind}`");
        builder.AppendLine($"- Linii: `{symbol.StartLine}`–`{symbol.EndLine}`");
        if (!string.IsNullOrWhiteSpace(symbol.Accessibility))
            builder.AppendLine($"- Acces: `{symbol.Accessibility}`");

        var outgoing = context.Graph.Edges.Where(edge => edge.From == symbol.FullName).OrderBy(edge => edge.To, StringComparer.Ordinal).ToList();
        var incoming = context.Graph.Edges.Where(edge => edge.To == symbol.FullName).OrderBy(edge => edge.From, StringComparer.Ordinal).ToList();
        builder.AppendLine();
        builder.AppendLine("## Referințe către alte simboluri");
        builder.AppendLine();
        foreach (var edge in outgoing)
            builder.AppendLine($"- către {SymbolLink(context, edge.To)} (`{edge.EdgeType}`)");
        if (outgoing.Count == 0)
            builder.AppendLine("- Nicio muchie de ieșire inclusă în snapshot.");
        builder.AppendLine();
        builder.AppendLine("## Simboluri care îl referențiază");
        builder.AppendLine();
        foreach (var edge in incoming)
            builder.AppendLine($"- din {SymbolLink(context, edge.From)} (`{edge.EdgeType}`)");
        if (incoming.Count == 0)
            builder.AppendLine("- Nicio muchie de intrare inclusă în snapshot.");

        WriteText(Path.Combine(context.OutputRoot, "symbols", $"{Slug(symbol.FullName)}.md"), builder.ToString());
    }

    private static string SymbolLink(ExportContext context, string fullName)
        => context.IncludedSymbolNames.Contains(fullName)
            ? $"[[symbols/{Slug(fullName)}|{fullName}]]"
            : $"`{fullName}`";

    private static void WriteCanvas(ExportContext context)
    {
        var nodes = new List<object>
        {
            new { id = "index", type = "file", file = "index.md", x = 0, y = 0, width = 360, height = 220 }
        };
        var edges = new List<object>();
        for (var index = 0; index < context.Graph.Modules.Count; index++)
        {
            var module = context.Graph.Modules[index];
            var id = $"module-{index}";
            nodes.Add(new { id, type = "file", file = $"modules/{Slug(module.Key)}.md", x = 460 + (index % 3) * 420, y = (index / 3) * 260, width = 360, height = 180 });
            edges.Add(new { id = $"index-{id}", fromNode = "index", toNode = id, fromSide = "right", toSide = "left", label = "module" });
        }
        foreach (var (dependency, index) in ModuleDependencies(context.Graph).Select((value, index) => (value, index)))
        {
            var from = context.Graph.Modules.FindIndex(module => string.Equals(module.Key, dependency.From, StringComparison.OrdinalIgnoreCase));
            var to = context.Graph.Modules.FindIndex(module => string.Equals(module.Key, dependency.To, StringComparison.OrdinalIgnoreCase));
            if (from >= 0 && to >= 0)
                edges.Add(new { id = $"dependency-{index}", fromNode = $"module-{from}", toNode = $"module-{to}", label = dependency.Count.ToString() });
        }

        var canvas = new { nodes, edges };
        WriteText(Path.Combine(context.OutputRoot, "canvases", "code-map.canvas"), JsonSerializer.Serialize(canvas, new JsonSerializerOptions { WriteIndented = true }));
    }

    private static void WriteManifest(ExportContext context)
    {
        var manifest = new
        {
            schemaVersion = "1.0",
            generatedAt = context.GeneratedAt,
            sourceCommit = context.Graph.Commit,
            sourceBranch = context.Graph.Branch,
            workingTreeDirty = context.Graph.WorkingTreeDirty,
            scope = context.Graph.Scope,
            includeSymbols = context.IncludeSymbols,
            maxSymbols = context.MaxSymbols,
            files = context.Graph.Files.Select(file => new { path = file.Path, hash = file.Hash, language = file.Language }).ToList(),
            modules = context.Graph.Modules.Select(module => module.Key).ToList(),
            symbols = context.IncludedSymbolNames.OrderBy(name => name, StringComparer.Ordinal).ToList()
        };
        WriteText(Path.Combine(context.OutputRoot, ".export-manifest.json"), JsonSerializer.Serialize(manifest, new JsonSerializerOptions { WriteIndented = true }));
    }

    private static IReadOnlyList<ModuleDependency> ModuleDependencies(CodeGraph graph)
    {
        var result = graph.Edges
            .Select(edge => (From: ModuleKey(graph.FilesById[edge.FromFileId].Path), To: ModuleKey(graph.FilesById[edge.ToFileId].Path)))
            .Where(edge => !string.Equals(edge.From, edge.To, StringComparison.OrdinalIgnoreCase))
            .GroupBy(edge => edge, EqualityComparer<(string From, string To)>.Default)
            .Select(group => new ModuleDependency(group.Key.From, group.Key.To, group.Count()))
            .OrderBy(edge => edge.From, StringComparer.OrdinalIgnoreCase)
            .ThenBy(edge => edge.To, StringComparer.OrdinalIgnoreCase)
            .ToList();
        return result;
    }

    private static void AppendFrontmatter(StringBuilder builder, IReadOnlyDictionary<string, string?> values)
    {
        builder.AppendLine("---");
        foreach (var (key, value) in values)
            builder.AppendLine($"{key}: {Yaml(value)}");
        builder.AppendLine("---");
        builder.AppendLine();
    }

    private static string Yaml(string? value)
        => value is null ? "null" : $"\"{value.Replace("\\", "\\\\", StringComparison.Ordinal).Replace("\"", "\\\"", StringComparison.Ordinal).Replace("\r", " ", StringComparison.Ordinal).Replace("\n", " ", StringComparison.Ordinal)}\"";

    private static string EscapeMermaid(string value)
        => value.Replace("\\", "\\\\", StringComparison.Ordinal).Replace("\"", "'", StringComparison.Ordinal);

    private static string Slug(string value)
    {
        var slug = UnsafeSlugCharacters.Replace(value.ToLowerInvariant(), "-").Trim('-');
        return string.IsNullOrWhiteSpace(slug) ? "root" : slug;
    }

    private static string ModuleKey(string path)
    {
        var parts = path.Split('/', StringSplitOptions.RemoveEmptyEntries);
        return parts.Length >= 2 && string.Equals(parts[0], "modules", StringComparison.OrdinalIgnoreCase)
            ? $"modules/{parts[1]}"
            : parts.FirstOrDefault() ?? "_root";
    }

    private static bool IsInScope(string path, string scopeRelative)
        => scopeRelative is "." or "" || string.Equals(path, scopeRelative, StringComparison.OrdinalIgnoreCase) || path.StartsWith(scopeRelative.TrimEnd('/') + "/", StringComparison.OrdinalIgnoreCase);

    private static string ResolveInside(string root, string relativePath, string label)
    {
        var full = Path.GetFullPath(Path.Combine(root, relativePath));
        if (!IsWithin(root, full))
            throw new InvalidOperationException($"{label} path must stay inside the repository root.");
        return full;
    }

    private static bool IsWithin(string root, string candidate)
    {
        var normalizedRoot = Path.GetFullPath(root).TrimEnd(Path.DirectorySeparatorChar) + Path.DirectorySeparatorChar;
        var normalizedCandidate = Path.GetFullPath(candidate);
        return normalizedCandidate.StartsWith(normalizedRoot, StringComparison.OrdinalIgnoreCase) ||
               string.Equals(normalizedCandidate.TrimEnd(Path.DirectorySeparatorChar), normalizedRoot.TrimEnd(Path.DirectorySeparatorChar), StringComparison.OrdinalIgnoreCase);
    }

    private static void WriteText(string path, string content)
    {
        Directory.CreateDirectory(Path.GetDirectoryName(path)!);
        File.WriteAllText(path, content.EndsWith('\n') ? content : content + Environment.NewLine, new UTF8Encoding(false));
    }

    private static string? RunGit(string repositoryRoot, params string[] arguments)
    {
        try
        {
            using var process = new Process();
            process.StartInfo = new ProcessStartInfo
            {
                FileName = "git",
                WorkingDirectory = repositoryRoot,
                UseShellExecute = false,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                CreateNoWindow = true
            };
            foreach (var argument in arguments)
                process.StartInfo.ArgumentList.Add(argument);
            process.Start();
            var output = process.StandardOutput.ReadToEnd().Trim();
            process.WaitForExit(5_000);
            return process.ExitCode == 0 && output.Length > 0 ? output : null;
        }
        catch
        {
            return null;
        }
    }

    private sealed record CodeGraph(
        List<CodeFile> Files,
        Dictionary<long, CodeFile> FilesById,
        List<CodeSymbol> Symbols,
        List<CodeEdge> Edges,
        List<CodeModule> Modules,
        string? Branch,
        string? Commit,
        bool WorkingTreeDirty)
    {
        public string Scope { get; init; } = ".";
    }

    private sealed record CodeFile(long Id, string Path, string Language, string Hash, string IndexedAt);
    private sealed record CodeSymbol(long Id, long FileId, string Name, string FullName, string Kind, string Language, int StartLine, int EndLine, string? Accessibility, string? ParentSymbol);
    private sealed record CodeEdge(string From, string To, string EdgeType, long FromFileId, long ToFileId);
    private sealed record CodeModule(string Key, List<CodeFile> Files);
    private sealed record ModuleDependency(string From, string To, int Count);

    private sealed class ExportContext(string repositoryRoot, string outputRoot, CodeGraph graph, DateTimeOffset generatedAt, bool includeSymbols, int maxSymbols)
    {
        public string RepositoryRoot { get; } = repositoryRoot;
        public string OutputRoot { get; } = outputRoot;
        public CodeGraph Graph { get; } = graph;
        public DateTimeOffset GeneratedAt { get; } = generatedAt;
        public bool IncludeSymbols { get; } = includeSymbols;
        public int MaxSymbols { get; } = maxSymbols;
        public HashSet<string> IncludedSymbolNames { get; } = new(StringComparer.Ordinal);
    }
}

public sealed record ObsidianExportOptions
{
    public required string RepositoryRoot { get; init; }
    public required string DatabasePath { get; init; }
    public string ScopePath { get; init; } = ".";
    public string OutputPath { get; init; } = "docs/code-map/generated";
    public bool IncludeSymbols { get; init; }
    public int MaxSymbols { get; init; } = 250;
}

public sealed record ObsidianExportResult(
    string Status,
    string OutputPath,
    int Files,
    int Modules,
    int Symbols,
    int Edges,
    string? Branch,
    string? Commit,
    bool WorkingTreeDirty,
    DateTimeOffset GeneratedAt);
