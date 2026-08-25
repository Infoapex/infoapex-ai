using System.Diagnostics;
using System.Text;

namespace AiCodeControl.Memory.Services;

public sealed class MemoryTaskSummaryService
{
    public TaskSummaryResult Create(string repoRoot, string title, bool fromGitDiff)
    {
        var today = DateTime.UtcNow.ToString("yyyy-MM-dd");
        var slug = Slugify(title);
        var fileName = $"{today}-{slug}.md";
        var outputDir = Path.Combine(repoRoot, ".ai-code-control", "memory", "tasks");
        Directory.CreateDirectory(outputDir);
        var outputPath = Path.Combine(outputDir, fileName);
        var relativePath = Path.GetRelativePath(repoRoot, outputPath).Replace('\\', '/');

        var changedFiles = fromGitDiff ? GetGitChangedFiles(repoRoot) : new List<string>();

        var sb = new StringBuilder();
        sb.AppendLine($"# Task - {today} - {title}");
        sb.AppendLine();
        sb.AppendLine("## Goal");
        sb.AppendLine("TODO");
        sb.AppendLine();
        sb.AppendLine("## Context used");
        sb.AppendLine("- TODO");
        sb.AppendLine();
        sb.AppendLine("## Changed files");
        if (changedFiles.Count > 0)
            foreach (var f in changedFiles)
                sb.AppendLine($"- {f}");
        else
            sb.AppendLine("- (none detected - fill in manually)");
        sb.AppendLine();
        sb.AppendLine("## Changes made");
        sb.AppendLine("- TODO");
        sb.AppendLine();
        sb.AppendLine("## Validation");
        sb.AppendLine("- run-validation: TODO (paste per-toolchain results: pass/fail + notes)");
        sb.AppendLine();
        sb.AppendLine("## Open issues");
        sb.AppendLine("- TODO");
        sb.AppendLine();
        sb.AppendLine("## Next recommended task");
        sb.AppendLine("TODO");

        File.WriteAllText(outputPath, sb.ToString(), new UTF8Encoding(encoderShouldEmitUTF8Identifier: false));

        return new TaskSummaryResult { Path = relativePath, FileName = fileName };
    }

    private static List<string> GetGitChangedFiles(string repoRoot)
    {
        try
        {
            using var p = new Process();
            p.StartInfo = new ProcessStartInfo
            {
                FileName = "git",
                Arguments = "diff HEAD --name-status",
                WorkingDirectory = repoRoot,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false,
                CreateNoWindow = true
            };
            p.Start();
            // stderr must be drained too, or a chatty git can fill the pipe and hang.
            var stderrTask = p.StandardError.ReadToEndAsync();
            var output = p.StandardOutput.ReadToEnd();
            p.WaitForExit();
            _ = stderrTask.GetAwaiter().GetResult();

            var files = new List<string>();
            foreach (var line in output.Split(new[] { '\r', '\n' }, StringSplitOptions.RemoveEmptyEntries))
            {
                var parts = line.Split('\t', 2);
                if (parts.Length != 2) continue;
                var statusLabel = parts[0].Trim() switch
                {
                    "M" => "modified",
                    "A" => "added",
                    "D" => "deleted",
                    "R" => "renamed",
                    var s => s
                };
                files.Add($"{parts[1].Trim()} ({statusLabel})");
            }
            return files;
        }
        catch
        {
            return new List<string>();
        }
    }

    private static string Slugify(string title)
        => new string(title.ToLowerInvariant()
                .Select(c => char.IsLetterOrDigit(c) ? c : '-')
                .ToArray())
            .Replace("---", "-").Replace("--", "-").Trim('-');
}

public sealed class TaskSummaryResult
{
    public string Path     { get; set; } = "";
    public string FileName { get; set; } = "";
}
