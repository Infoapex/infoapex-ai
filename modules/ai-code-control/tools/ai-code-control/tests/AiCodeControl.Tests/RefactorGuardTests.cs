using System.Text.Json;
using AiCodeControl.Core.Models;
using AiCodeControl.RefactorGuard.Models;
using AiCodeControl.RefactorGuard.Services;
using Xunit;

namespace AiCodeControl.Tests;

public sealed class RefactorGuardTests : IDisposable
{
    private readonly string _root;

    public RefactorGuardTests()
    {
        _root = Path.Combine(Path.GetTempPath(), "acc-guard-tests", Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(Path.Combine(_root, ".ai-code-control", "tasks"));
        RunGit("init");
        RunGit("config user.email test@example.com");
        RunGit("config user.name Test");
        File.WriteAllText(Path.Combine(_root, "tracked.txt"), "initial");
        File.WriteAllText(Path.Combine(_root, ".gitignore"), ".env\n");
        RunGit("add tracked.txt .gitignore");
        RunGit("commit -m initial");
    }

    [Fact]
    public void Verify_DoesNotEnumerateGitIgnoredSecrets()
    {
        File.WriteAllText(Path.Combine(_root, ".env"), "SECRET=do-not-list");
        var plan = new RefactorPlan { Task = "none" };

        var result = new RefactorGuardService().VerifyChangedFiles(_root, plan, new CodeControlConfig());

        Assert.DoesNotContain(".env", result.ChangedFiles);
    }

    [Fact]
    public void Verify_FailsActiveTaskWithoutScope()
    {
        var plan = new RefactorPlan { Task = "Implement catalog", Status = "active" };
        var result = new RefactorGuardService().VerifyChangedFiles(_root, plan, new CodeControlConfig());
        Assert.Equal("fail", result.Status);
        Assert.Contains(result.Notes, note => note.Contains("no allowedFiles", StringComparison.Ordinal));
    }

    [Fact]
    public void Verify_AcceptsGlobScope_AndDetectsParallelOverlap()
    {
        File.AppendAllText(Path.Combine(_root, "tracked.txt"), "changed");
        var other = new RefactorPlan
        {
            TaskId = "TASK-OTHER",
            Task = "Other",
            Owner = "agent-b",
            Status = "active",
            AllowedPatterns = new List<string> { "tracked*" }
        };
        File.WriteAllText(Path.Combine(_root, ".ai-code-control", "tasks", "other.json"), JsonSerializer.Serialize(other));
        var current = new RefactorPlan
        {
            TaskId = "TASK-CURRENT",
            Task = "Current",
            Status = "active",
            AllowedFiles = new List<string> { "tracked.txt" },
            AllowedUntrackedPatterns = new List<string> { ".ai-code-control/tasks/" }
        };

        var result = new RefactorGuardService().VerifyChangedFiles(_root, current, new CodeControlConfig());

        Assert.Empty(result.UnexpectedFiles);
        Assert.Single(result.ConflictingTasks);
        Assert.Equal("fail", result.Status);
    }

    private void RunGit(string arguments)
    {
        using var process = System.Diagnostics.Process.Start(new System.Diagnostics.ProcessStartInfo
        {
            FileName = "git",
            Arguments = arguments,
            WorkingDirectory = _root,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
            CreateNoWindow = true
        })!;
        process.WaitForExit();
        if (process.ExitCode != 0)
            throw new InvalidOperationException(process.StandardError.ReadToEnd());
    }

    public void Dispose()
    {
        try { Directory.Delete(_root, recursive: true); } catch { }
    }
}
