using System.Text.Json;
using System.Text.Json.Serialization;
using AiCodeControl.Core.Models;

namespace AiCodeControl.Core.Services;

public static class ContextPackageJson
{
    private static readonly JsonSerializerOptions SerializerOptions = new(JsonSerializerDefaults.Web)
    {
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
        PropertyNameCaseInsensitive = false,
        UnmappedMemberHandling = JsonUnmappedMemberHandling.Disallow,
        WriteIndented = true
    };

    public static string Serialize(ContextPackage package)
    {
        ArgumentNullException.ThrowIfNull(package);
        var errors = ContextPackageDigest.Validate(package);
        if (errors.Count > 0)
        {
            throw new ArgumentException(
                $"Invalid context package: {string.Join("; ", errors)}",
                nameof(package));
        }

        return JsonSerializer.Serialize(package, SerializerOptions);
    }

    public static ContextPackage Deserialize(string json)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(json);
        var package = JsonSerializer.Deserialize<ContextPackage>(json, SerializerOptions)
            ?? throw new JsonException("Context package JSON was null");
        var errors = ContextPackageDigest.Validate(package);
        if (errors.Count > 0)
        {
            throw new JsonException($"Invalid context package: {string.Join("; ", errors)}");
        }

        return package;
    }
}
