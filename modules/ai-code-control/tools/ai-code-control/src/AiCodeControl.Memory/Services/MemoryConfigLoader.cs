using System.Text.Json;
using AiCodeControl.Memory.Models;

namespace AiCodeControl.Memory.Services;

public sealed class MemoryConfigLoader
{
    public MemoryControlConfig? Load(string repoRoot)
    {
        var path = Path.Combine(repoRoot, ".ai-code-control", "config", "memory-control.json");
        if (!File.Exists(path))
            return null;
        var json = File.ReadAllText(path);
        try
        {
            return JsonSerializer.Deserialize<MemoryControlConfig>(json, new JsonSerializerOptions
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
