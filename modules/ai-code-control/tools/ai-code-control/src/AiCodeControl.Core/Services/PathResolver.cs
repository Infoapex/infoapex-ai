namespace AiCodeControl.Core.Services;

public static class PathResolver
{
    public static string ResolveRepoRoot(string? startDir = null)
    {
        var dir = startDir ?? Directory.GetCurrentDirectory();
        var current = new DirectoryInfo(dir);

        while (current is not null)
        {
            var gitPath = Path.Combine(current.FullName, ".git");
            if (Directory.Exists(gitPath) || File.Exists(gitPath))
            {
                return current.FullName;
            }

            current = current.Parent;
        }

        return Directory.GetCurrentDirectory();
    }
}
