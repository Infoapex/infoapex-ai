using System.Text;
using AiCodeControl.Memory.Models;
using Microsoft.Data.Sqlite;

namespace AiCodeControl.Memory.Services;

public sealed class MemoryBriefService
{
    private static readonly string[] DefaultBriefCommands =
    {
        "memory-health                 # verify that canonical memory is current",
        "find-symbol <name>            # locate a symbol before editing",
        "impact-analysis <full.name>   # inspect transitive blast radius",
        "verify-changed-files          # enforce active task scope",
        "run-validation                # build, lint and test configured toolchains"
    };

    private readonly MemorySearchService _search = new();

    public string GenerateBrief(string repoRoot, string task, MemoryConfig config)
    {
        var maxTokens = Math.Max(200, config.MaxBriefingTokens);
        var sections = new List<string>();
        var recentMode = string.IsNullOrWhiteSpace(task);

        sections.Add("# Memory Brief\n");
        if (!recentMode)
            sections.Add($"## Task\n{task.Trim()}\n");

        var projectMemory = Path.Combine(repoRoot, ".ai-code-control", "memory", "project-memory.md");
        if (File.Exists(projectMemory))
        {
            // Compact (meaning-preserving) and cap project memory so it cannot alone
            // consume the whole brief budget; the canonical file is never modified.
            var content = MarkdownCompactor.Compact(File.ReadAllText(projectMemory)).Trim();
            var perDocCap = Math.Max(300, maxTokens / 2);
            var capped = MarkdownCompactor.HeadByTokens(content, perDocCap);
            var truncated = capped.Length < content.Length;
            sections.Add($"## Project memory\n```markdown\n{capped}\n```"
                + (truncated ? "\n_[project memory trimmed to fit the brief; full text in project-memory.md]_\n" : "\n"));
        }

        var dbPath = ResolveDbPath(repoRoot, config.Store);
        if (File.Exists(dbPath))
        {
            var matches = recentMode
                ? GetRecentItems(dbPath, config.MaxRecallItems)
                : _search.Search(dbPath, task, config.MaxRecallItems).Matches;
            // project-memory is already inlined above; drop it from the match lists
            // to avoid duplicating the same content (and its tokens) in the brief.
            matches = matches.Where(m => m.ItemType != "project-memory").ToList();
            sections.Add(BuildSection(recentMode ? "Recent decisions" : "Relevant decisions",
                matches.Where(m => m.ItemType == "adr")));
            sections.Add(BuildSection(recentMode ? "Recent tasks and handoffs" : "Relevant tasks and handoffs",
                matches.Where(m => m.ItemType is "task" or "summary" or "handoff")));
            sections.Add(BuildSection(recentMode ? "Other recent memory" : "Other relevant memory",
                matches.Where(m => m.ItemType is not ("adr" or "task" or "summary" or "handoff"))));
        }

        sections.Add("""
## Current constraints
- Treat versioned Markdown, ADRs, contracts and migrations as canonical; indexes are rebuildable caches.
- Work only inside the active task manifest and report scope changes before making them.
- Use a fully-qualified symbol when impact analysis reports ambiguity.
- Refresh memory and code indexes after material changes.
""");

        IEnumerable<string> commands = config.BriefCommands is { Count: > 0 } custom ? custom : DefaultBriefCommands;
        sections.Add("## Required next commands\n```text\n" + string.Join('\n', commands) + "\n```\n");

        return FitToBudget(sections.Where(s => !string.IsNullOrWhiteSpace(s)), maxTokens);
    }

    private static string BuildSection(string heading, IEnumerable<SearchMatch> items)
    {
        var list = items.ToList();
        if (list.Count == 0) return string.Empty;
        var builder = new StringBuilder($"## {heading}\n");
        foreach (var item in list)
        {
            builder.AppendLine($"- **{item.Title ?? Path.GetFileNameWithoutExtension(item.SourcePath)}** (`{item.SourcePath}`)");
            if (!string.IsNullOrWhiteSpace(item.Excerpt))
                builder.AppendLine($"  > {Flatten(item.Excerpt)}");
        }
        return builder.ToString();
    }

    private static string FitToBudget(IEnumerable<string> sections, int maxTokens)
    {
        var result = new StringBuilder();
        var used = 0;
        foreach (var section in sections)
        {
            var normalized = section.Trim() + "\n\n";
            var cost = TokenEstimator.Estimate(normalized);
            if (used + cost <= maxTokens)
            {
                result.Append(normalized);
                used += cost;
                continue;
            }

            var remaining = maxTokens - used;
            if (remaining > 40)
            {
                var head = MarkdownCompactor.HeadByTokens(normalized, remaining - 12);
                if (head.Length > 0)
                {
                    result.Append(head.TrimEnd());
                    result.Append("\n\n_[Brief truncated to maxBriefingTokens]_\n");
                }
            }
            break;
        }
        return result.ToString().TrimEnd() + "\n";
    }

    private static string Flatten(string excerpt)
        => string.Join(" ", excerpt.Split('\r', '\n').Select(line => line.Trim()).Where(line => line.Length > 0));

    private static List<SearchMatch> GetRecentItems(string dbPath, int maxItems)
    {
        var matches = new List<SearchMatch>();
        using var connection = new SqliteConnection($"Data Source={dbPath}");
        connection.Open();
        using var command = connection.CreateCommand();
        command.CommandText = @"
SELECT source_path, title, item_type, substr(content, 1, 300)
FROM memory_items ORDER BY updated_at DESC LIMIT $limit";
        command.Parameters.AddWithValue("$limit", Math.Clamp(maxItems, 1, 100));
        using var reader = command.ExecuteReader();
        while (reader.Read())
        {
            matches.Add(new SearchMatch
            {
                SourcePath = reader.GetString(0),
                Title = reader.IsDBNull(1) ? null : reader.GetString(1),
                ItemType = reader.GetString(2),
                Excerpt = reader.IsDBNull(3) ? null : reader.GetString(3)
            });
        }
        return matches;
    }

    private static string ResolveDbPath(string repoRoot, string? store)
        => string.IsNullOrEmpty(store)
            ? Path.Combine(repoRoot, ".ai-code-control", "db", "memory.sqlite")
            : Path.IsPathRooted(store)
                ? store
                : Path.Combine(repoRoot, store.Replace('/', Path.DirectorySeparatorChar));
}
