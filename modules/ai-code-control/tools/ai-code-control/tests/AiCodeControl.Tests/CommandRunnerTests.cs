using AiCodeControl.Core.Services;
using Xunit;

namespace AiCodeControl.Tests;

public sealed class CommandRunnerTests
{
    private static (string FileName, string Args) Shell(string windowsArgs, string bashScript)
        => OperatingSystem.IsWindows()
            ? ("cmd.exe", windowsArgs)
            : ("/bin/bash", $"-c \"{bashScript}\"");

    [Fact]
    public async Task VerboseCommand_DoesNotFalseTimeout_AndCapturesOutput()
    {
        // ~2MB of stdout: far beyond the ~4KB pipe buffer that used to deadlock
        // WaitForExitAsync and produce a false "timeout".
        var line = new string('x', 200);
        var (file, args) = Shell(
            $"/c for /L %i in (1,1,10000) do @echo {line}",
            $"for i in $(seq 1 10000); do echo {line}; done");

        var result = await new CommandRunner().RunAsync(file, args, Path.GetTempPath(), timeoutSeconds: 60);

        Assert.Equal("pass", result.Status);
        Assert.Equal(0, result.ExitCode);
        Assert.NotNull(result.Output);
        Assert.Contains("xxxx", result.Output);
    }

    [Fact]
    public async Task HangingCommand_TimesOutAndGetsKilled()
    {
        var (file, args) = Shell(
            "/c ping -n 30 127.0.0.1 > nul",
            "sleep 30");

        var result = await new CommandRunner().RunAsync(file, args, Path.GetTempPath(), timeoutSeconds: 2);

        Assert.Equal("timeout", result.Status);
        Assert.Null(result.ExitCode);
        Assert.True(result.DurationMs < 20_000, $"Kill took too long: {result.DurationMs}ms");
    }

    [Fact]
    public async Task FailingCommand_ReportsExitCodeStdoutAndStderr()
    {
        var (file, args) = Shell(
            "/c echo out-marker & echo err-marker 1>&2 & exit /b 3",
            "echo out-marker; echo err-marker 1>&2; exit 3");

        var result = await new CommandRunner().RunAsync(file, args, Path.GetTempPath(), timeoutSeconds: 30);

        Assert.Equal("fail", result.Status);
        Assert.Equal(3, result.ExitCode);
        Assert.Contains("out-marker", result.Output);
        Assert.Contains("err-marker", result.Error);
    }

    [Fact]
    public async Task HugeOutput_IsTruncatedKeepingTail()
    {
        var line = new string('y', 200);
        var (file, args) = Shell(
            $"/c (for /L %i in (1,1,10000) do @echo {line}) & echo tail-marker",
            $"for i in $(seq 1 10000); do echo {line}; done; echo tail-marker");

        var result = await new CommandRunner().RunAsync(file, args, Path.GetTempPath(), timeoutSeconds: 60);

        Assert.Equal("pass", result.Status);
        Assert.NotNull(result.Output);
        Assert.True(result.Output!.Length < 25_000, $"Output not truncated: {result.Output.Length} chars");
        Assert.Contains("tail-marker", result.Output);
    }
}
