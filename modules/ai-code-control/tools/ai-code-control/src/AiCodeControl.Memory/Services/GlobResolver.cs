using System.Text.RegularExpressions;

namespace AiCodeControl.Memory.Services;

public static class GlobResolver
{
    // Generated/vendored directories are never descended into: a wildcard include
    // at repo root would otherwise traverse node_modules/.git on large monorepos.
    private static readonly HashSet<string> SkippedDirectories = new(StringComparer.OrdinalIgnoreCase)
    {
        ".git", "node_modules", "bin", "obj", "dist", "build", "target",
        ".next", ".turbo", "coverage", "__pycache__", ".venv", "venv",
        ".pytest_cache", ".mypy_cache", ".ruff_cache"
    };

    public static IEnumerable<string> Resolve(string repoRoot, string pattern)
    {
        var norm = pattern.Replace('\\', '/');

        if (!norm.Contains('*') && !norm.Contains('?'))
        {
            var fullPath = Path.Combine(repoRoot, norm.Replace('/', Path.DirectorySeparatorChar));
            if (File.Exists(fullPath))
                yield return norm;
            yield break;
        }

        // Find base directory: everything before the first wildcard character
        var starIdx = norm.IndexOfAny(new[] { '*', '?' });
        var lastSlash = norm.LastIndexOf('/', starIdx);
        var baseRel = lastSlash > 0 ? norm[..lastSlash] : "";
        var baseFull = string.IsNullOrEmpty(baseRel)
            ? repoRoot
            : Path.Combine(repoRoot, baseRel.Replace('/', Path.DirectorySeparatorChar));

        if (!Directory.Exists(baseFull))
            yield break;

        foreach (var file in EnumerateFiles(baseFull))
        {
            var relative = Path.GetRelativePath(repoRoot, file).Replace('\\', '/');
            if (Matches(norm, relative))
                yield return relative;
        }
    }

    public static bool IsExcluded(string relativePath, IEnumerable<string> excludePatterns)
        => excludePatterns.Any(p => Matches(p.Replace('\\', '/'), relativePath));

    internal static bool Matches(string pattern, string path)
    {
        // Regex.Escape does not escape '/', so "**/" escapes to @"\*\*/" —
        // the replaced token must match that exactly. "**/" means
        // "zero or more directory levels".
        var regexStr = "^" + Regex.Escape(pattern)
            .Replace(@"\*\*/", @"([^/]+/)*")
            .Replace(@"\*\*", @".*")
            .Replace(@"\*", @"[^/]*")
            .Replace(@"\?", @"[^/]") + "$";
        return Regex.IsMatch(path, regexStr, RegexOptions.IgnoreCase);
    }

    private static IEnumerable<string> EnumerateFiles(string root)
    {
        var pending = new Stack<string>();
        pending.Push(root);

        while (pending.Count > 0)
        {
            var dir = pending.Pop();
            string[] files;
            string[] subdirs;
            try
            {
                files = Directory.GetFiles(dir);
                subdirs = Directory.GetDirectories(dir);
            }
            catch (UnauthorizedAccessException)
            {
                continue;
            }
            catch (IOException)
            {
                continue;
            }

            foreach (var file in files)
                yield return file;

            foreach (var subdir in subdirs)
            {
                if (!SkippedDirectories.Contains(Path.GetFileName(subdir)))
                    pending.Push(subdir);
            }
        }
    }
}
