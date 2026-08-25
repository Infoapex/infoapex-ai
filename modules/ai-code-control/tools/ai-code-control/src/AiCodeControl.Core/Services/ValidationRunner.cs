using System.Text;
using AiCodeControl.Core.Models;

namespace AiCodeControl.Core.Services;

public sealed class ValidationRunner
{
    private readonly CommandRunner _runner = new();

    public async Task<ValidationSummary> RunAsync(string repoRoot, CodeControlConfig? config)
    {
        var summary = new ValidationSummary();
        if (config is null)
        {
            summary.Results.Add(new ValidationCommandResult("config", "fail", null, 0, "code-control.json not found"));
            return summary;
        }

        var toolchains = config.Toolchains?.Where(t => t.Enabled).ToList();
        if (toolchains is null || toolchains.Count == 0)
        {
            summary.Results.Add(new ValidationCommandResult("toolchains", "skipped", null, 0, "No enabled toolchains in code-control.json"));
            return summary;
        }

        foreach (var toolchain in toolchains)
        {
            var name = toolchain.Name ?? "toolchain";
            if (toolchain.Commands is null || toolchain.Commands.Count == 0)
            {
                summary.Results.Add(new ValidationCommandResult(name, "skipped", null, 0, "No commands configured"));
                continue;
            }

            var workdir = ResolveWorkdir(repoRoot, toolchain.Path);
            foreach (var command in toolchain.Commands)
            {
                await AddCommand(summary, $"{name}.{command.Name ?? "cmd"}", command.Run, workdir, command.TimeoutSeconds);
            }
        }

        return summary;
    }

    private async Task AddCommand(ValidationSummary summary, string name, string? command, string workdir, int timeout)
    {
        if (string.IsNullOrWhiteSpace(command))
        {
            summary.Results.Add(new ValidationCommandResult(name, "skipped", null, 0));
            return;
        }

        string shell;
        string args;
        if (OperatingSystem.IsWindows())
        {
            // -EncodedCommand sidesteps PowerShell quoting entirely: quotes,
            // $, backticks and pipes in configured commands pass through intact.
            shell = "powershell";
            var encoded = Convert.ToBase64String(Encoding.Unicode.GetBytes(command));
            args = $"-NoProfile -EncodedCommand {encoded}";
        }
        else
        {
            shell = "/bin/bash";
            var escaped = command
                .Replace("\\", "\\\\")
                .Replace("\"", "\\\"")
                .Replace("$", "\\$")
                .Replace("`", "\\`");
            args = $"-lc \"{escaped}\"";
        }

        var result = await _runner.RunAsync(shell, args, workdir, timeout);

        // Output/stderr are included only on failure/timeout: the agent needs to
        // see WHY a check failed, but passing runs should not bloat the JSON
        // (PowerShell emits CLIXML progress noise on stderr even on success).
        var output = result.Status == "pass" ? null : result.Output;
        var error = result.Status == "pass" ? null : result.Error;
        summary.Results.Add(new ValidationCommandResult(name, result.Status, result.ExitCode, result.DurationMs, error, output));
    }

    private static string ResolveWorkdir(string repoRoot, string? path)
    {
        if (string.IsNullOrWhiteSpace(path) || path == ".")
        {
            return repoRoot;
        }

        return Path.GetFullPath(Path.Combine(repoRoot, path));
    }
}
