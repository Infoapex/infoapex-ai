using System.Text.Json;
using AiCodeControl.Core.Models;

namespace AiCodeControl.Core.Services;

public sealed class ConfigLoader
{
    public CodeControlConfig? LoadCodeControl(string repoRoot)
    {
        var path = Path.Combine(repoRoot, ".ai-code-control", "config", "code-control.json");
        if (!File.Exists(path))
        {
            return null;
        }

        var json = File.ReadAllText(path);
        try
        {
            return JsonSerializer.Deserialize<CodeControlConfig>(json, new JsonSerializerOptions
            {
                PropertyNameCaseInsensitive = true
            });
        }
        catch (JsonException ex)
        {
            throw new InvalidOperationException($"Invalid JSON in {path}: {ex.Message}", ex);
        }
    }
}
