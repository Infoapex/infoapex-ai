using Microsoft.Data.Sqlite;

namespace AiCodeControl.Core.Services;

public sealed class SymbolQueryService
{
    public object FindSymbol(string dbPath, string query, int limit = 50)
    {
        using var connection = new SqliteConnection($"Data Source={dbPath}");
        connection.Open();

        using var command = connection.CreateCommand();
        command.CommandText = @"
SELECT s.name, s.full_name, s.kind, s.language, f.path, s.start_line, s.end_line
FROM symbols s
JOIN files f ON f.id = s.file_id
WHERE s.name LIKE $query ESCAPE '\' OR s.full_name LIKE $query ESCAPE '\'
ORDER BY
  CASE WHEN s.full_name = $exact THEN 0 WHEN s.name = $exact THEN 1 ELSE 2 END,
  s.full_name, f.path
LIMIT $limit;";
        command.Parameters.AddWithValue("$query", $"%{EscapeLike(query)}%");
        command.Parameters.AddWithValue("$exact", query);
        command.Parameters.AddWithValue("$limit", Math.Clamp(limit, 1, 500));

        var items = new List<object>();
        using var reader = command.ExecuteReader();
        while (reader.Read())
        {
            items.Add(new
            {
                name = reader.GetString(0),
                fullName = reader.GetString(1),
                kind = reader.GetString(2),
                language = reader.GetString(3),
                file = reader.GetString(4),
                startLine = reader.GetInt32(5),
                endLine = reader.GetInt32(6)
            });
        }

        return new { query, count = items.Count, symbols = items };
    }

    public object ImpactAnalysis(string dbPath, string symbolInput, int maxDepth = 5)
    {
        using var connection = new SqliteConnection($"Data Source={dbPath}");
        connection.Open();

        var candidates = ResolveCandidates(connection, symbolInput);
        if (candidates.Count == 0)
            return new { target = symbolInput, status = "not_found" };
        if (candidates.Count > 1)
            return new
            {
                target = symbolInput,
                status = "ambiguous",
                message = "Use a fully-qualified symbol name.",
                candidates
            };

        var target = candidates[0];
        var queue = new Queue<(string Symbol, int Depth)>();
        var visited = new HashSet<string>(StringComparer.Ordinal) { target };
        var impacts = new List<ImpactItem>();
        var files = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        queue.Enqueue((target, 0));

        while (queue.Count > 0)
        {
            var (current, depth) = queue.Dequeue();
            if (depth >= Math.Clamp(maxDepth, 1, 20))
                continue;

            foreach (var edge in ReadIncomingEdges(connection, current))
            {
                var nextDepth = depth + 1;
                impacts.Add(new ImpactItem(edge.From, current, edge.Type, edge.File, nextDepth));
                if (!string.IsNullOrWhiteSpace(edge.File))
                    files.Add(edge.File);
                if (visited.Add(edge.From))
                    queue.Enqueue((edge.From, nextDepth));
            }
        }

        var ordered = impacts
            .DistinctBy(i => new { i.From, i.To, i.EdgeType, i.File, i.Depth })
            .OrderBy(i => i.Depth)
            .ThenBy(i => i.File, StringComparer.OrdinalIgnoreCase)
            .ThenBy(i => i.From, StringComparer.Ordinal)
            .ToList();
        var direct = ordered.Count(i => i.Depth == 1);
        var risk = (files.Count, ordered.Count) switch
        {
            (> 30, _) or (_, > 100) => "high",
            (> 10, _) or (_, > 30) => "medium",
            _ => "low"
        };

        return new
        {
            target,
            status = "ok",
            maxDepth = Math.Clamp(maxDepth, 1, 20),
            directCallers = direct,
            transitiveCallers = ordered.Count - direct,
            affectedSymbols = ordered.Select(i => i.From).Distinct(StringComparer.Ordinal).Count(),
            affectedFiles = files.Count,
            riskLevel = risk,
            impacts = ordered.Select(i => new
            {
                from = i.From,
                to = i.To,
                edgeType = i.EdgeType,
                file = i.File,
                depth = i.Depth
            })
        };
    }

    private static List<string> ResolveCandidates(SqliteConnection connection, string input)
    {
        using var exact = connection.CreateCommand();
        exact.CommandText = "SELECT DISTINCT full_name FROM symbols WHERE full_name = $input ORDER BY full_name";
        exact.Parameters.AddWithValue("$input", input);
        var exactMatches = ReadStrings(exact);
        if (exactMatches.Count > 0)
            return exactMatches;

        using var byName = connection.CreateCommand();
        byName.CommandText = "SELECT DISTINCT full_name FROM symbols WHERE name = $input ORDER BY full_name LIMIT 50";
        byName.Parameters.AddWithValue("$input", input);
        return ReadStrings(byName);
    }

    private static List<IncomingEdge> ReadIncomingEdges(SqliteConnection connection, string target)
    {
        using var command = connection.CreateCommand();
        command.CommandText = @"
SELECT e.from_symbol, e.edge_type, COALESCE(f.path, '')
FROM edges e
LEFT JOIN files f ON f.id = e.file_id
WHERE e.to_symbol = $target
ORDER BY f.path, e.from_symbol;";
        command.Parameters.AddWithValue("$target", target);
        var result = new List<IncomingEdge>();
        using var reader = command.ExecuteReader();
        while (reader.Read())
            result.Add(new IncomingEdge(reader.GetString(0), reader.GetString(1), reader.GetString(2)));
        return result;
    }

    private static List<string> ReadStrings(SqliteCommand command)
    {
        var result = new List<string>();
        using var reader = command.ExecuteReader();
        while (reader.Read()) result.Add(reader.GetString(0));
        return result;
    }

    private static string EscapeLike(string value)
        => value.Replace("\\", "\\\\", StringComparison.Ordinal)
            .Replace("%", "\\%", StringComparison.Ordinal)
            .Replace("_", "\\_", StringComparison.Ordinal);

    private sealed record IncomingEdge(string From, string Type, string File);
    private sealed record ImpactItem(string From, string To, string EdgeType, string File, int Depth);
}
