using System.Text.Json.Serialization;
using Microsoft.Data.Sqlite;

namespace AiCodeControl.Memory.Services;

public sealed class MemorySearchService
{
    public SearchResult Search(string dbPath, string query, int maxItems = 8)
    {
        var result = new SearchResult { Query = query };

        if (!File.Exists(dbPath))
            return result;

        using var conn = new SqliteConnection($"Data Source={dbPath}");
        conn.Open();

        var ftsQuery = BuildFtsQuery(query);

        using var cmd = conn.CreateCommand();
        cmd.CommandText = @"
SELECT m.source_path,
       m.title,
       m.item_type,
       snippet(memory_fts, 1, '[', ']', '...', 12) AS excerpt
FROM memory_fts f
JOIN memory_items m ON m.id = f.rowid
WHERE memory_fts MATCH $q
ORDER BY rank
LIMIT $limit";
        cmd.Parameters.AddWithValue("$q", ftsQuery);
        cmd.Parameters.AddWithValue("$limit", maxItems);

        using var reader = cmd.ExecuteReader();
        while (reader.Read())
        {
            result.Matches.Add(new SearchMatch
            {
                SourcePath = reader.GetString(0),
                Title      = reader.IsDBNull(1) ? null : reader.GetString(1),
                ItemType   = reader.GetString(2),
                Excerpt    = reader.IsDBNull(3) ? null : reader.GetString(3)
            });
        }

        return result;
    }

    private static readonly HashSet<string> StopWords = new(StringComparer.OrdinalIgnoreCase)
    {
        // English
        "the", "a", "an", "and", "or", "for", "to", "in", "of", "on", "with",
        "is", "are", "be", "this", "that", "it", "as", "at", "by", "from",
        // Romanian (ASCII forms; the tokenizer strips diacritics anyway)
        "si", "sa", "se", "de", "la", "cu", "un", "o", "pentru", "din", "pe",
        "care", "este", "sunt", "fie", "mai", "nu", "ca", "il", "le"
    };

    // OR semantics with BM25 ranking: a multi-word task description should
    // surface the best partial matches, not demand every word (strict AND
    // returned zero results for almost any real task phrasing).
    internal static string BuildFtsQuery(string query)
    {
        var tokens = Tokenize(query);
        var keywords = tokens
            .Where(w => w.Length >= 2 && !StopWords.Contains(w))
            .Distinct(StringComparer.OrdinalIgnoreCase)
            .Take(12)
            .ToList();

        if (keywords.Count == 0)
            keywords = tokens.Distinct(StringComparer.OrdinalIgnoreCase).Take(12).ToList();

        return string.Join(" OR ", keywords.Select(w => $"\"{w.Replace("\"", "\"\"")}\""));
    }

    private static List<string> Tokenize(string query)
        => query
            .Split(new[] { ' ', '\t', '\r', '\n', ',', ';', ':', '(', ')', '[', ']', '{', '}', '"', '\'', '/', '\\' },
                StringSplitOptions.RemoveEmptyEntries)
            .ToList();
}

public sealed class SearchResult
{
    [JsonPropertyName("query")]   public string Query { get; set; } = "";
    [JsonPropertyName("matches")] public List<SearchMatch> Matches { get; set; } = new();
}

public sealed class SearchMatch
{
    [JsonPropertyName("sourcePath")] public string  SourcePath { get; set; } = "";
    [JsonPropertyName("title")]      public string? Title      { get; set; }
    [JsonPropertyName("itemType")]   public string  ItemType   { get; set; } = "";
    [JsonPropertyName("excerpt")]    public string? Excerpt    { get; set; }
}
