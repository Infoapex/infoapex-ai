using System.Diagnostics;

namespace AiCodeControl.Core.Services;

public sealed record CommandRunResult(
    string Status,
    int? ExitCode,
    long DurationMs,
    string? Output,
    string? Error);

public sealed class CommandRunner
{
    private const int MaxCapturedChars = 20_000;

    public async Task<CommandRunResult> RunAsync(
        string fileName,
        string arguments,
        string workingDirectory,
        int timeoutSeconds,
        CancellationToken cancellationToken = default)
    {
        using var process = new Process();
        process.StartInfo = new ProcessStartInfo
        {
            FileName = fileName,
            Arguments = arguments,
            WorkingDirectory = workingDirectory,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
            CreateNoWindow = true
        };

        var sw = Stopwatch.StartNew();
        process.Start();

        // Both pipes must be drained while the process runs: a redirected pipe
        // has a ~4KB buffer, and a child that fills it blocks on write, so
        // WaitForExitAsync would never complete (false "timeout" on verbose tools).
        var stdoutTask = process.StandardOutput.ReadToEndAsync(CancellationToken.None);
        var stderrTask = process.StandardError.ReadToEndAsync(CancellationToken.None);

        using var cts = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        cts.CancelAfter(TimeSpan.FromSeconds(Math.Max(1, timeoutSeconds)));

        try
        {
            await process.WaitForExitAsync(cts.Token);
            sw.Stop();

            var stdout = Truncate(await stdoutTask);
            var stderr = Truncate(await stderrTask);

            return process.ExitCode == 0
                ? new CommandRunResult("pass", process.ExitCode, sw.ElapsedMilliseconds, stdout, NullIfBlank(stderr))
                : new CommandRunResult("fail", process.ExitCode, sw.ElapsedMilliseconds, stdout, stderr);
        }
        catch (OperationCanceledException)
        {
            try
            {
                if (!process.HasExited)
                {
                    process.Kill(true);
                }
            }
            catch
            {
            }

            sw.Stop();

            // Kill closes the pipes, so the pending reads complete with whatever
            // the process managed to write before it was stopped.
            var stdout = Truncate(await ReadSafely(stdoutTask));
            var stderr = Truncate(await ReadSafely(stderrTask));
            var error = string.IsNullOrWhiteSpace(stderr)
                ? "Command timed out."
                : $"Command timed out. Stderr: {stderr}";

            return new CommandRunResult("timeout", null, sw.ElapsedMilliseconds, NullIfBlank(stdout), error);
        }
    }

    private static async Task<string?> ReadSafely(Task<string> readTask)
    {
        try
        {
            return await readTask.WaitAsync(TimeSpan.FromSeconds(5));
        }
        catch
        {
            return null;
        }
    }

    private static string? Truncate(string? value)
    {
        if (value is null || value.Length <= MaxCapturedChars)
        {
            return value;
        }

        return $"[truncated {value.Length - MaxCapturedChars} chars, tail kept]\n{value[^MaxCapturedChars..]}";
    }

    private static string? NullIfBlank(string? value)
        => string.IsNullOrWhiteSpace(value) ? null : value;
}
