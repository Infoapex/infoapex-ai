using AiCodeControl.Core.Models;
using AiCodeControl.Core.Services;
using Xunit;

namespace AiCodeControl.Tests;

public sealed class ValidationRunnerTests
{
    [Fact]
    public async Task RunsConfiguredToolchainCommands_AndNamesResults()
    {
        var config = new CodeControlConfig
        {
            Toolchains = new List<ToolchainConfig>
            {
                new()
                {
                    Name = "demo",
                    Enabled = true,
                    Path = ".",
                    Commands = new List<ToolchainCommand>
                    {
                        new() { Name = "hello", Run = "echo hello-toolchain", TimeoutSeconds = 30 }
                    }
                }
            }
        };

        var summary = await new ValidationRunner().RunAsync(Path.GetTempPath(), config);

        var result = Assert.Single(summary.Results);
        Assert.Equal("demo.hello", result.Name);
        Assert.Equal("pass", result.Status);
    }

    [Fact]
    public async Task FailingCommand_ReportsFailWithOutput()
    {
        var failCommand = OperatingSystem.IsWindows() ? "cmd /c \"echo broken & exit /b 5\"" : "echo broken; exit 5";
        var config = new CodeControlConfig
        {
            Toolchains = new List<ToolchainConfig>
            {
                new()
                {
                    Name = "demo",
                    Commands = new List<ToolchainCommand>
                    {
                        new() { Name = "fail", Run = failCommand, TimeoutSeconds = 30 }
                    }
                }
            }
        };

        var summary = await new ValidationRunner().RunAsync(Path.GetTempPath(), config);

        var result = Assert.Single(summary.Results);
        Assert.Equal("fail", result.Status);
        Assert.Contains("broken", result.Output);
    }

    [Fact]
    public async Task DisabledOrEmptyToolchains_AreSkipped()
    {
        var config = new CodeControlConfig
        {
            Toolchains = new List<ToolchainConfig>
            {
                new() { Name = "off", Enabled = false },
                new() { Name = "empty", Enabled = true }
            }
        };

        var summary = await new ValidationRunner().RunAsync(Path.GetTempPath(), config);

        var result = Assert.Single(summary.Results);
        Assert.Equal("empty", result.Name);
        Assert.Equal("skipped", result.Status);
    }
}
