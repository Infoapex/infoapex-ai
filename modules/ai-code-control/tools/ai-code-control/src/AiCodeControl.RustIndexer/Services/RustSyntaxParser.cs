using System.Security.Cryptography;
using System.Text;
using AiCodeControl.RustIndexer.Models;
using TreeSitter;

namespace AiCodeControl.RustIndexer.Services;

internal static class RustSyntaxParser
{
    public static RustFileIndex Parse(string repoRoot, string file, string crateName, string crateRoot)
    {
        var source = File.ReadAllText(file);
        var module = ModuleName(crateName, crateRoot, file);
        var symbols = new List<RustSymbol>();
        var references = new List<RustReference>();
        var imports = new List<RustImport>();
        using var language = new Language("Rust");
        using var parser = new Parser(language);
        using var tree = parser.Parse(source) ?? throw new InvalidOperationException($"Could not parse Rust file {file}.");
        Walk(tree.RootNode, module, module);
        return new RustFileIndex(
            Path.GetRelativePath(repoRoot, file).Replace('\\', '/'),
            Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(source))).ToLowerInvariant(),
            symbols, references, crateName, module, imports);

        void Walk(Node node, string scope, string namespaceName)
        {
            switch (node.Type)
            {
                case "mod_item":
                    var modName = Field(node, "name")?.Text;
                    if (modName is not null && Field(node, "body") is { } modBody)
                        WalkChildren(modBody, namespaceName + "::" + modName, namespaceName + "::" + modName);
                    return;
                case "use_declaration":
                    if (Field(node, "argument") is { } argument)
                        ReadUse(argument, "", namespaceName, imports, references);
                    return;
                case "struct_item":
                case "enum_item":
                case "trait_item":
                case "type_item":
                case "union_item":
                    var name = Field(node, "name")?.Text;
                    if (string.IsNullOrWhiteSpace(name)) return;
                    var kind = node.Type switch
                    {
                        "struct_item" => "struct",
                        "enum_item" => "enum",
                        "trait_item" => "trait",
                        "type_item" => "type",
                        _ => "union"
                    };
                    var full = namespaceName + "::" + name;
                    AddSymbol(name, full, kind, node, namespaceName);
                    ReadBounds(node, full);
                    if (node.Type == "type_item") ReadTypes(Field(node, "type"), full, "uses_type");
                    WalkChildren(node, full, namespaceName);
                    return;
                case "impl_item":
                    var implType = Field(node, "type");
                    var trait = Field(node, "trait");
                    var typeText = implType?.Text ?? "?";
                    var implFull = namespaceName + "::impl(" + (trait is null ? typeText : trait.Text + " for " + typeText) + ")@" + (node.StartPosition.Row + 1);
                    AddSymbol("impl", implFull, "impl", node, namespaceName);
                    ReadTypes(implType, implFull, "implemented_by");
                    ReadTypes(trait, implFull, "implements");
                    ReadBounds(node, implFull);
                    WalkChildren(node, implFull, namespaceName);
                    return;
                case "function_item":
                case "function_signature_item":
                    var fnName = Field(node, "name")?.Text;
                    if (string.IsNullOrWhiteSpace(fnName)) return;
                    var parent = scope.Contains("::impl(", StringComparison.Ordinal) || scope != namespaceName ? scope : namespaceName;
                    var fnFull = parent + "::" + fnName;
                    AddSymbol(fnName, fnFull, parent.Contains("::impl(", StringComparison.Ordinal) ? "method" : "function", node, parent);
                    if (Field(node, "parameters") is { } parameters)
                        foreach (var parameter in parameters.NamedChildren)
                            ReadTypes(Field(parameter, "type"), fnFull, "uses_type");
                    ReadTypes(Field(node, "return_type"), fnFull, "uses_type");
                    ReadBounds(node, fnFull);
                    WalkChildren(node, fnFull, namespaceName);
                    return;
                case "field_declaration":
                    ReadTypes(Field(node, "type"), scope, "uses_type");
                    return;
                case "call_expression":
                    var callable = Field(node, "function");
                    if (callable is not null)
                    {
                        var token = callable.Type == "field_expression" ? (Field(callable, "value")?.Text + "." + Field(callable, "field")?.Text) : callable.Text;
                        if (!string.IsNullOrWhiteSpace(token)) AddReference(token, scope, callable, "call", "calls");
                    }
                    break;
            }
            WalkChildren(node, scope, namespaceName);
        }

        void WalkChildren(Node node, string scope, string namespaceName)
        {
            foreach (var child in node.NamedChildren)
                Walk(child, scope, namespaceName);
        }

        void AddSymbol(string name, string full, string kind, Node node, string parent)
        {
            var visibility = node.Children.Any(c => c.Type == "visibility_modifier") ? "public" : null;
            symbols.Add(new RustSymbol(name, full, kind, node.StartPosition.Row + 1, node.EndPosition.Row + 1, parent, visibility));
        }

        void AddReference(string token, string from, Node node, string kind, string edge)
            => references.Add(new RustReference(token, from, node.StartPosition.Row + 1, node.StartPosition.Column + 1, kind, edge));

        void ReadTypes(Node? root, string from, string edge)
        {
            if (root is null) return;
            if (root.Type is "scoped_type_identifier" or "scoped_identifier")
            {
                AddReference(root.Text, from, root, "type", edge);
                return;
            }
            if (root.Type == "type_identifier")
            {
                AddReference(root.Text, from, root, "type", edge);
                return;
            }
            foreach (var child in root.NamedChildren) ReadTypes(child, from, edge);
        }

        void ReadBounds(Node node, string from)
        {
            if (Field(node, "type_parameters") is { } parameters)
                foreach (var parameter in parameters.NamedChildren)
                    ReadTypes(Field(parameter, "bounds"), from, "trait_bound");
            if (node.NamedChildren.FirstOrDefault(c => c.Type == "where_clause") is { } where)
                foreach (var predicate in where.NamedChildren)
                    ReadTypes(predicate, from, "trait_bound");
        }
    }

    private static Node? Field(Node node, string name) => node.GetChildForField(name);

    private static void ReadUse(Node node, string prefix, string module, List<RustImport> imports, List<RustReference> references)
    {
        if (node.Type == "scoped_use_list")
        {
            var pathPrefix = Field(node, "path")?.Text ?? "";
            if (Field(node, "list") is { } list)
                foreach (var child in list.NamedChildren) ReadUse(child, Join(prefix, pathPrefix), module, imports, references);
            return;
        }
        if (node.Type == "use_list")
        {
            foreach (var child in node.NamedChildren) ReadUse(child, prefix, module, imports, references);
            return;
        }
        var pathNode = node.Type == "use_as_clause" ? Field(node, "path") : node;
        if (pathNode is null) return;
        var path = Join(prefix, pathNode.Text);
        if (path.EndsWith("::*", StringComparison.Ordinal)) return;
        var local = node.Type == "use_as_clause" ? Field(node, "alias")?.Text : path.Split("::").Last();
        if (string.IsNullOrWhiteSpace(local)) return;
        imports.Add(new RustImport(path, local, module));
        references.Add(new RustReference(path, module, node.StartPosition.Row + 1, node.StartPosition.Column + 1, "import", "imports"));
    }

    private static string Join(string prefix, string path) => string.IsNullOrEmpty(prefix) ? path : prefix + "::" + path;

    private static string ModuleName(string crateName, string crateRoot, string file)
    {
        var rel = Path.GetRelativePath(Path.Combine(crateRoot, "src"), file).Replace('\\', '/');
        if (rel.StartsWith("../", StringComparison.Ordinal))
            return crateName + "::" + Path.GetFileNameWithoutExtension(file);
        if (rel is "lib.rs" or "main.rs" or "mod.rs") return crateName;
        var stem = rel.EndsWith("/mod.rs", StringComparison.Ordinal) ? rel[..^7] : rel[..^3];
        return crateName + "::" + stem.Replace("/", "::");
    }
}
