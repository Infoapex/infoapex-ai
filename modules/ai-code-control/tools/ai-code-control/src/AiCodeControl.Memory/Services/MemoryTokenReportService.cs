using System.Text.Json.Serialization;
using AiCodeControl.Memory.Models;
using Microsoft.Data.Sqlite;

namespace AiCodeControl.Memory.Services;

/// <summary>
/// Measures the token footprint of the persistent memory store so token
/// reduction can be tracked over time. Reports the total indexed tokens, a
/// breakdown by item type, the largest items, and the size of the recent-mode
/// brief the SessionStart hook injects into every session. All counts are
/// estimates from <see cref="TokenEstimator"/>.
/// </summary>
public sealed class MemoryTokenReportService
{
    public TokenReport Report(string repoRoot, MemoryConfig config, int topItems = 10)
    {
        var report = new TokenReport { BriefBudget = Math.Max(200, config.MaxBriefingTokens) };
        var dbPath = ResolveDbPath(repoRoot, config.Store);

        if (File.Exists(dbPath))
        {
            using var connection = new SqliteConnection($"Data Source={dbPath}");
            connection.Open();
            using var command = connection.CreateCommand();
            command.CommandText = "SELECT source_path, item_type, content FROM memory_items";
            using var reader = command.ExecuteReader();

            var byType = new Dictionary<string, TokenGroup>(StringComparer.Ordinal);
            var items = new List<TokenItem>();
            while (reader.Read())
            {
                var sourcePath = reader.GetString(0);
                var itemType = reader.GetString(1);
                var content = reader.IsDBNull(2) ? string.Empty : reader.GetString(2);
                var tokens = TokenEstimator.Estimate(content);

                report.TotalItems++;
                report.TotalTokens += tokens;
                items.Add(new TokenItem { SourcePath = sourcePath, ItemType = itemType, Tokens = tokens });

                if (!byType.TryGetValue(itemType, out var group))
                {
                    group = new TokenGroup { ItemType = itemType };
                    byType[itemType] = group;
                }
                group.Items++;
                group.Tokens += tokens;
            }

            report.ByType = byType.Values.OrderByDescending(g => g.Tokens).ToList();
            report.LargestItems = items
                .OrderByDescending(i => i.Tokens)
                .Take(Math.Max(1, topItems))
                .ToList();
        }

        var brief = new MemoryBriefService().GenerateBrief(repoRoot, string.Empty, config);
        report.BriefTokens = TokenEstimator.Estimate(brief);

        return report;
    }

    private static string ResolveDbPath(string repoRoot, string? store)
        => string.IsNullOrEmpty(store)
            ? Path.Combine(repoRoot, ".ai-code-control", "db", "memory.sqlite")
            : Path.IsPathRooted(store)
                ? store
                : Path.Combine(repoRoot, store.Replace('/', Path.DirectorySeparatorChar));
}

public sealed class TokenReport
{
    [JsonPropertyName("status")] public string Status { get; set; } = "ok";
    [JsonPropertyName("totalItems")] public int TotalItems { get; set; }
    [JsonPropertyName("totalTokens")] public int TotalTokens { get; set; }
    [JsonPropertyName("briefTokens")] public int BriefTokens { get; set; }
    [JsonPropertyName("briefBudget")] public int BriefBudget { get; set; }
    [JsonPropertyName("byType")] public List<TokenGroup> ByType { get; set; } = new();
    [JsonPropertyName("largestItems")] public List<TokenItem> LargestItems { get; set; } = new();
}

public sealed class TokenGroup
{
    [JsonPropertyName("itemType")] public string ItemType { get; set; } = "";
    [JsonPropertyName("items")] public int Items { get; set; }
    [JsonPropertyName("tokens")] public int Tokens { get; set; }
}

public sealed class TokenItem
{
    [JsonPropertyName("sourcePath")] public string SourcePath { get; set; } = "";
    [JsonPropertyName("itemType")] public string ItemType { get; set; } = "";
    [JsonPropertyName("tokens")] public int Tokens { get; set; }
}
