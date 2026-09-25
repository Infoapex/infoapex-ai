using AiCodeControl.RustIndexer.Models;

namespace AiCodeControl.RustIndexer.Services;

// This resolver uses declared paths and local imports. It does not perform Rust type checking.
internal sealed class RustReferenceResolver
{
    private readonly HashSet<string> symbols;

    public RustReferenceResolver(IEnumerable<RustFileIndex> files)
    {
        symbols = files.SelectMany(f => f.Symbols).Select(s => s.FullName).ToHashSet(StringComparer.Ordinal);
    }

    public bool HasSymbol(string name) => symbols.Contains(name);

    public string? Resolve(RustFileIndex file, string token, string? from)
    {
        if (string.IsNullOrWhiteSpace(token)) return null;
        var paths = new HashSet<string>(StringComparer.Ordinal);
        if (token.StartsWith("self.", StringComparison.Ordinal) && from is not null)
        {
            var implAt = from.LastIndexOf("::impl(", StringComparison.Ordinal);
            if (implAt >= 0)
            {
                var method = from[..from.LastIndexOf("::", StringComparison.Ordinal)] + "::" + token[5..];
                if (symbols.Contains(method)) return method;
            }
            return null;
        }
        if (token.Contains('.')) return null;
        AddPath(token);
        var head = token.Split("::", 2)[0];
        foreach (var import in file.Imports.Where(i => i.LocalName == head && (from == i.ModuleName || from?.StartsWith(i.ModuleName + "::", StringComparison.Ordinal) == true)))
        {
            var tail = token.Length == head.Length ? "" : token[head.Length..];
            AddPath(import.Path + tail, import.ModuleName);
        }
        var direct = paths.Where(symbols.Contains).ToList();
        if (direct.Count == 1) return direct[0];
        if (direct.Count > 1) return null;
        return null;

        void AddPath(string path, string? contextModule = null)
        {
            if (path.StartsWith("crate::", StringComparison.Ordinal))
                path = file.CrateName + path[5..];
            else if (path.StartsWith("self::", StringComparison.Ordinal))
                path = (contextModule ?? file.ModuleName) + path[4..];
            else if (path.StartsWith("super::", StringComparison.Ordinal))
            {
                var scopeModule = contextModule ?? file.ModuleName;
                var parent = scopeModule.Contains("::", StringComparison.Ordinal)
                    ? scopeModule[..scopeModule.LastIndexOf("::", StringComparison.Ordinal)] : file.CrateName;
                path = parent + path[5..];
            }
            paths.Add(path);
            if (path.StartsWith(file.CrateName + "::", StringComparison.Ordinal)) return;
            var module = contextModule ?? file.ModuleName;
            while (true)
            {
                paths.Add(module + "::" + path);
                if (module == file.CrateName) break;
                module = module[..module.LastIndexOf("::", StringComparison.Ordinal)];
            }
        }
    }
}
