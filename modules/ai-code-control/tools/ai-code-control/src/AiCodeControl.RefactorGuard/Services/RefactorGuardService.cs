using System.Diagnostics;
using System.Text.Json;
using System.Text.RegularExpressions;
using AiCodeControl.Core.Models;
using AiCodeControl.Core.Services;
using AiCodeControl.RefactorGuard.Models;

namespace AiCodeControl.RefactorGuard.Services;

public sealed class RefactorGuardService
{
    // Paths matching these prefixes are silently filtered before guard checks.
    // They represent generated artifacts that should never trigger unexpected-file warnings.
    private static readonly string[] DefaultGeneratedPrefixes =
    {
        "bin/", "obj/", ".ai-code-control/db/",
        "node_modules/", ".next/", "dist/", "build/", "coverage/", ".turbo/",
        "__pycache__/", ".pytest_cache/", ".mypy_cache/",
        ".ruff_cache/", ".venv/", "venv/", "target/"
    };

    public RefactorPlan LoadPlan(string repoRoot, string planPath)
    {
        var full = Path.IsPathRooted(planPath) ? planPath : Path.GetFullPath(Path.Combine(repoRoot, planPath));
        var json = File.ReadAllText(full);
        return JsonSerializer.Deserialize<RefactorPlan>(json, new JsonSerializerOptions { PropertyNameCaseInsensitive = true })
               ?? new RefactorPlan();
    }

    public VerifyChangedFilesResult VerifyChangedFiles(string repoRoot, RefactorPlan plan, CodeControlConfig? config)
    {
        var branch = RunGit(repoRoot, "branch --show-current").Trim();
        // Ask Git to enumerate untracked files itself so .gitignore rules are
        // respected. Expanding an untracked directory with Directory APIs can
        // accidentally surface ignored secrets and traverse huge vendor trees.
        var (changed, untrackedFiles, filteredCount) = ParsePorcelain(
            repoRoot,
            RunGit(repoRoot, "status --porcelain --untracked-files=all"));

        var normalizedAllowed = new HashSet<string>(plan.AllowedFiles.Select(NormalizePath), StringComparer.OrdinalIgnoreCase);
        var allowedPatterns = plan.AllowedPatterns.Select(NormalizePath).ToList();
        var normalizedForbidden = new HashSet<string>(plan.ForbiddenPaths.Select(NormalizePath), StringComparer.OrdinalIgnoreCase);

        var result = new VerifyChangedFilesResult
        {
            Branch = branch,
            ChangedFiles = changed,
            FilteredArtifactsCount = filteredCount
        };

        foreach (var file in changed)
        {
            var nf = NormalizePath(file);
            var forbidden = normalizedForbidden.Any(fp => nf.StartsWith(fp, StringComparison.OrdinalIgnoreCase));
            if (forbidden)
            {
                result.ForbiddenFiles.Add(file);
                continue;
            }

            var hasScope = normalizedAllowed.Count > 0 || allowedPatterns.Count > 0;
            if (hasScope && !normalizedAllowed.Contains(nf) && !allowedPatterns.Any(pattern => GlobMatches(pattern, nf)))
            {
                result.UnexpectedFiles.Add(file);
            }
        }

        // Apply allowedUntrackedPatterns: untracked files matching a prefix are silently allowed.
        if (plan.AllowedUntrackedPatterns.Count > 0)
        {
            var allowedUntrackedNorm = plan.AllowedUntrackedPatterns.Select(NormalizePath).ToList();
            var toAllow = result.UnexpectedFiles
                .Where(f => untrackedFiles.Contains(f) &&
                            allowedUntrackedNorm.Any(p => NormalizePath(f).StartsWith(p, StringComparison.OrdinalIgnoreCase)))
                .ToList();
            foreach (var f in toAllow)
            {
                result.UnexpectedFiles.Remove(f);
                result.AllowedUntrackedFiles.Add(f);
            }
        }

        var protectedBranches = config?.Git?.ProtectedBranches ?? new List<string>();
        var onProtected = protectedBranches.Any(b => string.Equals(b, branch, StringComparison.OrdinalIgnoreCase));

        var violations = new List<string>();
        var activeTask = !string.IsNullOrWhiteSpace(plan.Task) &&
                         !string.Equals(plan.Task, "none", StringComparison.OrdinalIgnoreCase);
        if (activeTask && normalizedAllowed.Count == 0 && allowedPatterns.Count == 0)
            violations.Add("Active task has no allowedFiles or allowedPatterns scope.");
        if (!string.IsNullOrWhiteSpace(plan.Branch) && !string.Equals(plan.Branch, branch, StringComparison.OrdinalIgnoreCase))
            violations.Add($"Task manifest expects branch '{plan.Branch}', current branch is '{branch}'.");
        if (onProtected)
            violations.Add($"Current branch '{branch}' is protected.");
        if (result.UnexpectedFiles.Count > 0)
            violations.Add("Files outside allowedFiles were modified.");
        if (result.ForbiddenFiles.Count > 0)
            violations.Add("Forbidden paths were modified.");

        result.ConflictingTasks.AddRange(FindConflictingTasks(repoRoot, plan));
        if (result.ConflictingTasks.Count > 0)
            violations.Add("Active task scope overlaps another active task manifest.");

        result.Notes.AddRange(violations);

        if (filteredCount > 0)
            result.Notes.Add($"{filteredCount} generated artifact(s) filtered (bin/, obj/, .ai-code-control/db/, etc.).");

        result.Status = violations.Count == 0 ? "pass" : "fail";
        return result;
    }

    public async Task<object> RunRefactorGuard(string repoRoot, RefactorPlan plan, CodeControlConfig? config)
    {
        var verify = VerifyChangedFiles(repoRoot, plan, config);
        var validation = await new ValidationRunner().RunAsync(repoRoot, config);
        var validationFailed = validation.Results.Any(r => r.Status is "fail" or "timeout");

        var status = verify.Status == "pass" && !validationFailed ? "pass" : "fail";
        return new
        {
            schemaVersion = 1,
            status,
            changedFiles = verify.ChangedFiles,
            unexpectedFiles = verify.UnexpectedFiles,
            forbiddenFiles = verify.ForbiddenFiles,
            conflictingTasks = verify.ConflictingTasks,
            allowedUntrackedFiles = verify.AllowedUntrackedFiles,
            filteredArtifactsCount = verify.FilteredArtifactsCount,
            branch = verify.Branch,
            notes = verify.Notes,
            validation = validation.Results,
            riskLevel = plan.RiskLevel ?? "unknown"
        };
    }

    private static bool IsGeneratedArtifact(string normalizedPath)
    {
        foreach (var prefix in DefaultGeneratedPrefixes)
        {
            if (normalizedPath.StartsWith(prefix, StringComparison.OrdinalIgnoreCase))
                return true;
            // Match inside any sub-directory (e.g. tools/ai-code-control/src/.../bin/Debug/...)
            if (normalizedPath.Contains("/" + prefix, StringComparison.OrdinalIgnoreCase))
                return true;
        }
        return false;
    }

    public List<string> FindConflictingTasks(string repoRoot, RefactorPlan current)
    {
        var taskDirectory = Path.Combine(repoRoot, ".ai-code-control", "tasks");
        if (!Directory.Exists(taskDirectory))
            return new List<string>();

        var currentScopes = current.AllowedFiles.Concat(current.AllowedPatterns)
            .Select(NormalizePath).Where(path => path.Length > 0).ToList();
        if (currentScopes.Count == 0)
            return new List<string>();

        var conflicts = new List<string>();
        foreach (var file in Directory.EnumerateFiles(taskDirectory, "*.json", SearchOption.TopDirectoryOnly))
        {
            RefactorPlan? candidate;
            try
            {
                candidate = JsonSerializer.Deserialize<RefactorPlan>(File.ReadAllText(file),
                    new JsonSerializerOptions { PropertyNameCaseInsensitive = true });
            }
            catch (JsonException)
            {
                conflicts.Add($"{Path.GetFileName(file)}: invalid manifest");
                continue;
            }

            if (candidate == null || string.Equals(candidate.TaskId, current.TaskId, StringComparison.OrdinalIgnoreCase))
                continue;
            if (candidate.Status is not ("active" or "in_progress"))
                continue;

            var otherScopes = candidate.AllowedFiles.Concat(candidate.AllowedPatterns)
                .Select(NormalizePath).Where(path => path.Length > 0).ToList();
            var overlap = currentScopes.FirstOrDefault(left => otherScopes.Any(right => ScopesOverlap(left, right)));
            if (overlap != null)
                conflicts.Add($"{candidate.TaskId ?? Path.GetFileNameWithoutExtension(file)} ({candidate.Owner ?? "unowned"}): {overlap}");
        }
        return conflicts;
    }

    private static bool ScopesOverlap(string left, string right)
    {
        var leftPrefix = StaticPrefix(left);
        var rightPrefix = StaticPrefix(right);
        if (leftPrefix.Length == 0 || rightPrefix.Length == 0)
            return true;
        return leftPrefix.StartsWith(rightPrefix, StringComparison.OrdinalIgnoreCase) ||
               rightPrefix.StartsWith(leftPrefix, StringComparison.OrdinalIgnoreCase) ||
               GlobMatches(left, rightPrefix) || GlobMatches(right, leftPrefix);
    }

    private static string StaticPrefix(string pattern)
    {
        var wildcard = pattern.IndexOfAny(new[] { '*', '?' });
        return (wildcard < 0 ? pattern : pattern[..wildcard]).TrimEnd('/');
    }

    private static bool GlobMatches(string pattern, string path)
    {
        if (!pattern.Contains('*') && !pattern.Contains('?'))
            return string.Equals(pattern, path, StringComparison.OrdinalIgnoreCase);
        var regex = "^" + Regex.Escape(pattern)
            .Replace(@"\*\*/", @"([^/]+/)*")
            .Replace(@"\*\*", @".*")
            .Replace(@"\*", @"[^/]*")
            .Replace(@"\?", @"[^/]") + "$";
        return Regex.IsMatch(path, regex, RegexOptions.IgnoreCase);
    }

    private static (List<string> Files, HashSet<string> UntrackedFiles, int FilteredCount) ParsePorcelain(string repoRoot, string stdout)
    {
        var lines = stdout.Split(new[] { '\r', '\n' }, StringSplitOptions.RemoveEmptyEntries);
        var files = new List<string>();
        var untracked = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        var filteredCount = 0;

        foreach (var line in lines)
        {
            if (line.Length < 4)
                continue;

            var statusXY = line[..2];
            var isUntracked = statusXY == "??";

            var path = line.Substring(3).Trim();
            if (path.Contains(" -> "))
                path = path.Split(" -> ", 2)[1].Trim();
            if (string.IsNullOrWhiteSpace(path))
                continue;

            var normalizedPath = path.Replace('\\', '/');

            if (!normalizedPath.EndsWith("/", StringComparison.Ordinal))
            {
                var nf = NormalizePath(normalizedPath);
                if (IsGeneratedArtifact(nf))
                {
                    filteredCount++;
                    continue;
                }
                files.Add(normalizedPath);
                if (isUntracked) untracked.Add(normalizedPath);
                continue;
            }

            // Git porcelain may report untracked directories as "?? dir/".
            // Skip expanding directories that are known generated artifact roots.
            var dirNorm = NormalizePath(normalizedPath.TrimEnd('/') + "/");
            if (IsGeneratedArtifact(dirNorm))
            {
                filteredCount++;
                continue;
            }

            var absoluteDir = Path.GetFullPath(Path.Combine(repoRoot, normalizedPath));
            if (!Directory.Exists(absoluteDir))
            {
                var trimmed = normalizedPath.TrimEnd('/');
                if (!IsGeneratedArtifact(NormalizePath(trimmed)))
                {
                    files.Add(trimmed);
                    if (isUntracked) untracked.Add(trimmed);
                }
                else
                {
                    filteredCount++;
                }
                continue;
            }

            foreach (var child in Directory.EnumerateFiles(absoluteDir, "*", SearchOption.AllDirectories))
            {
                var relative = Path.GetRelativePath(repoRoot, child).Replace('\\', '/');
                var nf = NormalizePath(relative);
                if (IsGeneratedArtifact(nf))
                {
                    filteredCount++;
                    continue;
                }
                files.Add(relative);
                if (isUntracked) untracked.Add(relative);
            }
        }

        return (files.Distinct(StringComparer.OrdinalIgnoreCase).ToList(), untracked, filteredCount);
    }

    private static string RunGit(string repoRoot, string args)
    {
        using var p = new Process();
        p.StartInfo = new ProcessStartInfo
        {
            FileName = "git",
            Arguments = args,
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
        return output;
    }

    private static string NormalizePath(string p)
    {
        var n = p.Replace('\\', '/').Trim();
        while (n.StartsWith("./", StringComparison.Ordinal))
            n = n[2..];
        return n;
    }
}
