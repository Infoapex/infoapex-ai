using AiCodeControl.CodeIndexer.Models;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;

namespace AiCodeControl.CodeIndexer.Parsing;

internal static class CSharpAstParser
{
    public static (List<CodeSymbol> Symbols, List<CodeReference> References) Parse(
        string relativePath,
        string content)
    {
        var tree = CSharpSyntaxTree.ParseText(content, new CSharpParseOptions(LanguageVersion.Latest));
        var root = tree.GetCompilationUnitRoot();
        var symbols = new List<CodeSymbol>();
        var references = new List<CodeReference>();
        var fileSymbol = "file:" + relativePath.Replace('\\', '/');

        foreach (var type in root.DescendantNodes().OfType<BaseTypeDeclarationSyntax>())
        {
            var fullName = FullTypeName(type);
            var parent = type.Ancestors().OfType<BaseTypeDeclarationSyntax>().FirstOrDefault() is { } parentType
                ? FullTypeName(parentType)
                : NamespaceName(type) is { Length: > 0 } ns ? ns : fileSymbol;
            var kind = type switch
            {
                ClassDeclarationSyntax => "class",
                InterfaceDeclarationSyntax => "interface",
                StructDeclarationSyntax => "struct",
                RecordDeclarationSyntax record when record.ClassOrStructKeyword.IsKind(SyntaxKind.StructKeyword) => "record-struct",
                RecordDeclarationSyntax => "record",
                EnumDeclarationSyntax => "enum",
                _ => "type"
            };
            symbols.Add(Symbol(type.Identifier.ValueText, fullName, kind, type, parent, Accessibility(type.Modifiers)));

            if (type.BaseList != null)
            {
                foreach (var baseType in type.BaseList.Types)
                    references.Add(Reference(baseType.Type.ToString(), fullName, baseType, "inherits"));
            }
        }

        foreach (var declaration in root.DescendantNodes().OfType<DelegateDeclarationSyntax>())
        {
            var parent = ContainingTypeOrNamespace(declaration, fileSymbol);
            symbols.Add(Symbol(declaration.Identifier.ValueText, Join(parent, declaration.Identifier.ValueText),
                "delegate", declaration, parent, Accessibility(declaration.Modifiers)));
        }

        foreach (var method in root.DescendantNodes().OfType<BaseMethodDeclarationSyntax>())
        {
            var (name, kind) = method switch
            {
                MethodDeclarationSyntax value => (value.Identifier.ValueText, "method"),
                ConstructorDeclarationSyntax value => (value.Identifier.ValueText, "constructor"),
                DestructorDeclarationSyntax value => (value.Identifier.ValueText, "destructor"),
                OperatorDeclarationSyntax value => ("operator" + value.OperatorToken.ValueText, "operator"),
                ConversionOperatorDeclarationSyntax value => ("operator" + value.Type, "operator"),
                _ => ("method", "method")
            };
            var parent = ContainingTypeOrNamespace(method, fileSymbol);
            symbols.Add(Symbol(name, Join(parent, name), kind, method, parent, Accessibility(method.Modifiers)));
        }

        foreach (var local in root.DescendantNodes().OfType<LocalFunctionStatementSyntax>())
        {
            var parent = ContainingCallableOrType(local, fileSymbol);
            symbols.Add(Symbol(local.Identifier.ValueText, Join(parent, local.Identifier.ValueText),
                "local-function", local, parent, Accessibility(local.Modifiers)));
        }

        foreach (var property in root.DescendantNodes().OfType<PropertyDeclarationSyntax>())
        {
            var parent = ContainingTypeOrNamespace(property, fileSymbol);
            symbols.Add(Symbol(property.Identifier.ValueText, Join(parent, property.Identifier.ValueText),
                "property", property, parent, Accessibility(property.Modifiers)));
        }

        foreach (var usingDirective in root.Usings)
        {
            if (usingDirective.Name != null)
                references.Add(Reference(usingDirective.Name.ToString(), fileSymbol, usingDirective, "imports"));
        }

        foreach (var invocation in root.DescendantNodes().OfType<InvocationExpressionSyntax>())
        {
            var token = InvocationName(invocation.Expression);
            if (!string.IsNullOrWhiteSpace(token))
                references.Add(Reference(token, ContainingCallableOrType(invocation, fileSymbol), invocation, "calls"));
        }

        foreach (var creation in root.DescendantNodes().OfType<ObjectCreationExpressionSyntax>())
            references.Add(Reference(creation.Type.ToString(), ContainingCallableOrType(creation, fileSymbol), creation, "constructs"));

        return (symbols, references);
    }

    private static CodeSymbol Symbol(
        string name,
        string fullName,
        string kind,
        SyntaxNode node,
        string? parent,
        string? accessibility)
    {
        var span = node.SyntaxTree.GetLineSpan(node.Span);
        return new CodeSymbol(name, fullName, kind,
            span.StartLinePosition.Line + 1, span.EndLinePosition.Line + 1, parent, accessibility);
    }

    private static CodeReference Reference(string token, string from, SyntaxNode node, string kind)
    {
        var position = node.SyntaxTree.GetLineSpan(node.Span).StartLinePosition;
        return new CodeReference(token, from, position.Line + 1, position.Character + 1, kind);
    }

    private static string InvocationName(ExpressionSyntax expression)
        => expression switch
        {
            IdentifierNameSyntax identifier => identifier.Identifier.ValueText,
            GenericNameSyntax generic => generic.Identifier.ValueText,
            MemberAccessExpressionSyntax member => member.Name switch
            {
                IdentifierNameSyntax identifier => identifier.Identifier.ValueText,
                GenericNameSyntax generic => generic.Identifier.ValueText,
                _ => member.Name.ToString()
            },
            MemberBindingExpressionSyntax binding => binding.Name.Identifier.ValueText,
            _ => expression.ToString()
        };

    private static string FullTypeName(BaseTypeDeclarationSyntax type)
    {
        var parents = type.Ancestors().OfType<BaseTypeDeclarationSyntax>()
            .Reverse().Select(parent => parent.Identifier.ValueText);
        var typePath = string.Join('.', parents.Append(type.Identifier.ValueText));
        return Join(NamespaceName(type), typePath);
    }

    private static string NamespaceName(SyntaxNode node)
        => string.Join('.', node.Ancestors().OfType<BaseNamespaceDeclarationSyntax>()
            .Reverse().Select(ns => ns.Name.ToString()));

    private static string ContainingTypeOrNamespace(SyntaxNode node, string fileSymbol)
    {
        if (node.Ancestors().OfType<BaseTypeDeclarationSyntax>().FirstOrDefault() is { } type)
            return FullTypeName(type);
        var ns = NamespaceName(node);
        return string.IsNullOrWhiteSpace(ns) ? fileSymbol : ns;
    }

    private static string ContainingCallableOrType(SyntaxNode node, string fileSymbol)
    {
        var callable = node.Ancestors().FirstOrDefault(ancestor =>
            ancestor is BaseMethodDeclarationSyntax or LocalFunctionStatementSyntax);
        if (callable is BaseMethodDeclarationSyntax method)
        {
            var name = method switch
            {
                MethodDeclarationSyntax value => value.Identifier.ValueText,
                ConstructorDeclarationSyntax value => value.Identifier.ValueText,
                DestructorDeclarationSyntax value => value.Identifier.ValueText,
                OperatorDeclarationSyntax value => "operator" + value.OperatorToken.ValueText,
                ConversionOperatorDeclarationSyntax value => "operator" + value.Type,
                _ => "method"
            };
            return Join(ContainingTypeOrNamespace(method, fileSymbol), name);
        }
        if (callable is LocalFunctionStatementSyntax local)
            return Join(ContainingCallableOrType(local, fileSymbol), local.Identifier.ValueText);
        return ContainingTypeOrNamespace(node, fileSymbol);
    }

    private static string? Accessibility(SyntaxTokenList modifiers)
    {
        var values = modifiers.Select(modifier => modifier.ValueText).ToHashSet(StringComparer.Ordinal);
        if (values.Contains("public")) return "public";
        if (values.Contains("private") && values.Contains("protected")) return "private protected";
        if (values.Contains("protected") && values.Contains("internal")) return "protected internal";
        if (values.Contains("private")) return "private";
        if (values.Contains("protected")) return "protected";
        if (values.Contains("internal")) return "internal";
        return null;
    }

    private static string Join(string? parent, string name)
        => string.IsNullOrWhiteSpace(parent) ? name : parent + "." + name;
}
