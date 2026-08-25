namespace AiCodeControl.Core.Models;

public sealed record ValidationCommandResult(
    string Name,
    string Status,
    int? ExitCode,
    long DurationMs,
    string? Error = null,
    string? Output = null);

public sealed class ValidationSummary
{
    public List<ValidationCommandResult> Results { get; } = new();
}
