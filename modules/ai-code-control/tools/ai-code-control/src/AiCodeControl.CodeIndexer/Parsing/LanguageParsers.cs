using AiCodeControl.CodeIndexer.Models;

namespace AiCodeControl.CodeIndexer.Parsing;

internal static class LanguageParsers
{
    private static readonly HashSet<string> ControlCalls = new(StringComparer.OrdinalIgnoreCase)
    {
        "if", "for", "foreach", "while", "switch", "catch", "using", "lock",
        "return", "throw", "new", "typeof", "nameof", "sizeof", "checked",
        "unchecked", "await", "function"
    };

    private static readonly HashSet<string> CSharpTypeKeywords = new(StringComparer.Ordinal)
    {
        "class", "interface", "struct", "record", "enum"
    };

    private static readonly HashSet<string> TypeScriptTypeKeywords = new(StringComparer.Ordinal)
    {
        "class", "interface", "enum", "type"
    };

    public static (List<CodeSymbol> Symbols, List<CodeReference> References) Parse(
        string language,
        string relativePath,
        string content)
    {
        if (language == "csharp")
            return CSharpAstParser.Parse(relativePath, content);

        var tokens = SyntaxLexer.Tokenize(content, language);
        return language switch
        {
            "typescript" or "javascript" => ParseTypeScript(tokens, relativePath),
            "sql" => ParseSql(tokens, relativePath),
            _ => (new List<CodeSymbol>(), new List<CodeReference>())
        };
    }

    private static (List<CodeSymbol>, List<CodeReference>) ParseCSharp(
        List<SyntaxToken> tokens,
        string relativePath)
    {
        var symbols = new List<CodeSymbol>();
        var references = new List<CodeReference>();
        var fileSymbol = FileSymbol(relativePath);
        var namespaceName = ReadCSharpNamespace(tokens);
        var ranges = new List<SymbolRange>();
        var declarationTokenIndexes = new HashSet<int>();

        for (var i = 0; i < tokens.Count - 1; i++)
        {
            if (!CSharpTypeKeywords.Contains(tokens[i].Text))
                continue;

            var nameIndex = NextIdentifier(tokens, i + 1);
            if (nameIndex < 0)
                continue;

            var openBrace = FindToken(tokens, nameIndex + 1, "{", stopAt: ";");
            var closeBrace = openBrace >= 0 ? FindMatching(tokens, openBrace, "{", "}") : nameIndex;
            var parent = FindInnermost(ranges, nameIndex)?.FullName;
            var fullName = JoinName(parent ?? namespaceName, tokens[nameIndex].Text);
            var kind = tokens[i].Text == "record" && nameIndex + 1 < tokens.Count && tokens[nameIndex + 1].Text == "struct"
                ? "record-struct"
                : tokens[i].Text;
            var accessibility = ReadAccessibility(tokens, i);
            symbols.Add(new CodeSymbol(tokens[nameIndex].Text, fullName, kind, tokens[i].Line,
                closeBrace >= 0 ? tokens[closeBrace].Line : tokens[nameIndex].Line, parent ?? namespaceName, accessibility));
            ranges.Add(new SymbolRange(openBrace < 0 ? nameIndex : openBrace, closeBrace < 0 ? nameIndex : closeBrace, fullName, kind));
            declarationTokenIndexes.Add(nameIndex);
        }

        for (var i = 0; i < tokens.Count - 1; i++)
        {
            if (tokens[i].Kind != SyntaxTokenKind.Identifier || tokens[i + 1].Text != "(")
                continue;
            if (ControlCalls.Contains(tokens[i].Text) || declarationTokenIndexes.Contains(i))
                continue;

            var closeParen = FindMatching(tokens, i + 1, "(", ")");
            if (closeParen < 0)
                continue;

            var container = FindInnermost(ranges, i);
            var isDeclaration = container != null && IsCSharpMethodDeclaration(tokens, i, closeParen);
            if (isDeclaration)
            {
                var bodyStart = closeParen + 1;
                while (bodyStart < tokens.Count && tokens[bodyStart].Text is "where" or "async")
                    bodyStart++;
                var openBrace = FindToken(tokens, closeParen + 1, "{", stopAt: ";", secondaryStop: "=>");
                var end = openBrace >= 0 ? FindMatching(tokens, openBrace, "{", "}") : closeParen;
                var fullName = JoinName(container!.FullName, tokens[i].Text);
                symbols.Add(new CodeSymbol(tokens[i].Text, fullName,
                    tokens[i].Text == LastName(container.FullName) ? "constructor" : "method",
                    tokens[i].Line, end >= 0 ? tokens[end].Line : tokens[i].Line,
                    container.FullName, ReadAccessibility(tokens, i)));
                ranges.Add(new SymbolRange(i, end < 0 ? closeParen : end, fullName, "method"));
                declarationTokenIndexes.Add(i);
            }
        }

        AddCallReferences(tokens, ranges, declarationTokenIndexes, fileSymbol, references);

        for (var i = 0; i < tokens.Count; i++)
        {
            if (tokens[i].Text != "using")
                continue;
            var name = ReadQualifiedName(tokens, i + 1, out _);
            if (!string.IsNullOrWhiteSpace(name))
                references.Add(new CodeReference(name, fileSymbol, tokens[i].Line, tokens[i].Column, "imports"));
        }

        return (symbols, references);
    }

    private static (List<CodeSymbol>, List<CodeReference>) ParseTypeScript(
        List<SyntaxToken> tokens,
        string relativePath)
    {
        var symbols = new List<CodeSymbol>();
        var references = new List<CodeReference>();
        var fileSymbol = FileSymbol(relativePath);
        var ranges = new List<SymbolRange>();
        var declarationTokenIndexes = new HashSet<int>();

        for (var i = 0; i < tokens.Count - 1; i++)
        {
            if (TypeScriptTypeKeywords.Contains(tokens[i].Text))
            {
                var nameIndex = NextIdentifier(tokens, i + 1);
                if (nameIndex < 0)
                    continue;
                var open = FindToken(tokens, nameIndex + 1, "{", stopAt: ";");
                var close = open >= 0 ? FindMatching(tokens, open, "{", "}") : nameIndex;
                var parent = FindInnermost(ranges, nameIndex)?.FullName ?? fileSymbol;
                var fullName = JoinName(parent, tokens[nameIndex].Text);
                symbols.Add(new CodeSymbol(tokens[nameIndex].Text, fullName, tokens[i].Text,
                    tokens[i].Line, close >= 0 ? tokens[close].Line : tokens[nameIndex].Line, parent,
                    ReadTsAccessibility(tokens, i)));
                ranges.Add(new SymbolRange(open < 0 ? nameIndex : open, close < 0 ? nameIndex : close, fullName, tokens[i].Text));
                declarationTokenIndexes.Add(nameIndex);
                continue;
            }

            if (tokens[i].Text == "function")
            {
                var nameIndex = NextIdentifier(tokens, i + 1);
                if (nameIndex < 0)
                    continue;
                var open = FindToken(tokens, nameIndex + 1, "{", stopAt: ";");
                var close = open >= 0 ? FindMatching(tokens, open, "{", "}") : nameIndex;
                var parent = FindInnermost(ranges, nameIndex)?.FullName ?? fileSymbol;
                var fullName = JoinName(parent, tokens[nameIndex].Text);
                symbols.Add(new CodeSymbol(tokens[nameIndex].Text, fullName, "function", tokens[i].Line,
                    close >= 0 ? tokens[close].Line : tokens[nameIndex].Line, parent,
                    HasModifier(tokens, i, "export") ? "export" : null));
                ranges.Add(new SymbolRange(nameIndex, close < 0 ? nameIndex : close, fullName, "function"));
                declarationTokenIndexes.Add(nameIndex);
            }
        }

        for (var i = 0; i < tokens.Count - 3; i++)
        {
            if (tokens[i].Text is not ("const" or "let" or "var") || tokens[i + 1].Kind != SyntaxTokenKind.Identifier)
                continue;
            var arrow = FindToken(tokens, i + 2, "=>", stopAt: ";");
            if (arrow < 0 || arrow - i > 40)
                continue;
            var nameIndex = i + 1;
            var open = arrow + 1 < tokens.Count && tokens[arrow + 1].Text == "{" ? arrow + 1 : -1;
            var close = open >= 0 ? FindMatching(tokens, open, "{", "}") : arrow;
            var parent = FindInnermost(ranges, nameIndex)?.FullName ?? fileSymbol;
            var fullName = JoinName(parent, tokens[nameIndex].Text);
            symbols.Add(new CodeSymbol(tokens[nameIndex].Text, fullName, "function", tokens[i].Line,
                close >= 0 ? tokens[close].Line : tokens[arrow].Line, parent,
                HasModifier(tokens, i, "export") ? "export" : null));
            ranges.Add(new SymbolRange(nameIndex, close < 0 ? arrow : close, fullName, "function"));
            declarationTokenIndexes.Add(nameIndex);
        }

        for (var i = 0; i < tokens.Count - 1; i++)
        {
            if (tokens[i].Text == "from" && tokens[i + 1].Kind == SyntaxTokenKind.String)
                references.Add(new CodeReference(tokens[i + 1].Text, fileSymbol, tokens[i].Line, tokens[i].Column, "imports"));
            else if (tokens[i].Text == "import" && tokens[i + 1].Kind == SyntaxTokenKind.String)
                references.Add(new CodeReference(tokens[i + 1].Text, fileSymbol, tokens[i].Line, tokens[i].Column, "imports"));
        }

        AddCallReferences(tokens, ranges, declarationTokenIndexes, fileSymbol, references);
        return (symbols, references);
    }

    private static (List<CodeSymbol>, List<CodeReference>) ParseSql(
        List<SyntaxToken> tokens,
        string relativePath)
    {
        var symbols = new List<CodeSymbol>();
        var references = new List<CodeReference>();
        var fileSymbol = FileSymbol(relativePath);
        string? currentSymbol = null;

        for (var i = 0; i < tokens.Count; i++)
        {
            if (EqualsIgnoreCase(tokens[i].Text, "CREATE"))
            {
                var cursor = i + 1;
                if (HasSequence(tokens, cursor, "OR", "REPLACE"))
                    cursor += 2;
                if (cursor < tokens.Count && EqualsIgnoreCase(tokens[cursor].Text, "UNIQUE"))
                    cursor++;
                if (cursor >= tokens.Count)
                    continue;

                var kind = tokens[cursor].Text.ToLowerInvariant();
                if (kind is not ("table" or "view" or "function" or "procedure" or "schema" or "index" or "trigger"))
                    continue;
                cursor++;
                if (HasSequence(tokens, cursor, "IF", "NOT", "EXISTS"))
                    cursor += 3;
                var declaredName = ReadQualifiedName(tokens, cursor, out _);
                if (string.IsNullOrWhiteSpace(declaredName))
                    continue;
                currentSymbol = "sql." + declaredName;
                symbols.Add(new CodeSymbol(LastName(declaredName), currentSymbol, kind, tokens[i].Line,
                    FindStatementEndLine(tokens, i), fileSymbol));
                continue;
            }

            var keyword = tokens[i].Text.ToUpperInvariant();
            if (keyword is not ("REFERENCES" or "FROM" or "JOIN" or "UPDATE" or "INTO" or "CALL"))
                continue;
            var name = ReadQualifiedName(tokens, i + 1, out _);
            if (!string.IsNullOrWhiteSpace(name))
                references.Add(new CodeReference("sql." + name, currentSymbol ?? fileSymbol,
                    tokens[i].Line, tokens[i].Column, keyword.ToLowerInvariant()));
        }

        return (symbols, references);
    }

    private static void AddCallReferences(
        List<SyntaxToken> tokens,
        List<SymbolRange> ranges,
        HashSet<int> declarationIndexes,
        string fileSymbol,
        List<CodeReference> references)
    {
        for (var i = 0; i < tokens.Count - 1; i++)
        {
            if (tokens[i].Kind != SyntaxTokenKind.Identifier || tokens[i + 1].Text != "(")
                continue;
            if (declarationIndexes.Contains(i) || ControlCalls.Contains(tokens[i].Text))
                continue;
            if (i > 0 && tokens[i - 1].Text is "class" or "interface" or "record" or "struct" or "enum")
                continue;

            var from = FindInnermost(ranges, i)?.FullName ?? fileSymbol;
            references.Add(new CodeReference(tokens[i].Text, from, tokens[i].Line, tokens[i].Column, "calls"));
        }
    }

    private static string ReadCSharpNamespace(List<SyntaxToken> tokens)
    {
        for (var i = 0; i < tokens.Count; i++)
        {
            if (tokens[i].Text != "namespace")
                continue;
            var value = ReadQualifiedName(tokens, i + 1, out _);
            if (!string.IsNullOrWhiteSpace(value))
                return value;
        }
        return string.Empty;
    }

    private static bool IsCSharpMethodDeclaration(List<SyntaxToken> tokens, int nameIndex, int closeParen)
    {
        if (nameIndex > 0 && tokens[nameIndex - 1].Text is "." or "?." or "new" or "return" or "throw" or "=" or ",")
            return false;
        if (closeParen + 1 >= tokens.Count)
            return false;

        for (var i = closeParen + 1; i < Math.Min(tokens.Count, closeParen + 25); i++)
        {
            if (tokens[i].Text is "{" or "=>" or ";")
                return true;
            if (tokens[i].Text is ")" or "=")
                return false;
        }
        return false;
    }

    private static string? ReadAccessibility(List<SyntaxToken> tokens, int index)
    {
        for (var i = Math.Max(0, index - 8); i < index; i++)
        {
            if (tokens[i].Text is "public" or "private" or "protected" or "internal")
                return tokens[i].Text;
            if (tokens[i].Text is ";" or "{" or "}")
                continue;
        }
        return null;
    }

    private static string? ReadTsAccessibility(List<SyntaxToken> tokens, int index)
    {
        if (HasModifier(tokens, index, "export")) return "export";
        if (HasModifier(tokens, index, "private")) return "private";
        if (HasModifier(tokens, index, "protected")) return "protected";
        if (HasModifier(tokens, index, "public")) return "public";
        return null;
    }

    private static bool HasModifier(List<SyntaxToken> tokens, int index, string modifier)
    {
        for (var i = Math.Max(0, index - 5); i < index; i++)
        {
            if (tokens[i].Text == modifier)
                return true;
            if (tokens[i].Text is ";" or "{" or "}")
                return false;
        }
        return false;
    }

    private static int NextIdentifier(List<SyntaxToken> tokens, int start)
    {
        for (var i = start; i < Math.Min(tokens.Count, start + 8); i++)
            if (tokens[i].Kind == SyntaxTokenKind.Identifier)
                return i;
        return -1;
    }

    private static int FindToken(List<SyntaxToken> tokens, int start, string wanted, string? stopAt = null, string? secondaryStop = null)
    {
        for (var i = start; i < tokens.Count; i++)
        {
            if (tokens[i].Text == wanted)
                return i;
            if (tokens[i].Text == stopAt || tokens[i].Text == secondaryStop)
                return -1;
        }
        return -1;
    }

    private static int FindMatching(List<SyntaxToken> tokens, int openIndex, string open, string close)
    {
        var depth = 0;
        for (var i = openIndex; i < tokens.Count; i++)
        {
            if (tokens[i].Text == open) depth++;
            else if (tokens[i].Text == close && --depth == 0) return i;
        }
        return -1;
    }

    private static string ReadQualifiedName(List<SyntaxToken> tokens, int start, out int end)
    {
        var parts = new List<string>();
        var expectName = true;
        end = start;
        for (var i = start; i < tokens.Count; i++)
        {
            if (expectName && tokens[i].Kind == SyntaxTokenKind.Identifier)
            {
                parts.Add(tokens[i].Text);
                expectName = false;
                end = i;
                continue;
            }
            if (!expectName && tokens[i].Text == ".")
            {
                expectName = true;
                continue;
            }
            break;
        }
        return string.Join('.', parts);
    }

    private static SymbolRange? FindInnermost(List<SymbolRange> ranges, int tokenIndex)
        => ranges.Where(r => r.Start <= tokenIndex && tokenIndex <= r.End)
            .OrderBy(r => r.End - r.Start)
            .FirstOrDefault();

    private static int FindStatementEndLine(List<SyntaxToken> tokens, int start)
    {
        for (var i = start; i < tokens.Count; i++)
            if (tokens[i].Text == ";")
                return tokens[i].Line;
        return tokens[start].Line;
    }

    private static bool HasSequence(List<SyntaxToken> tokens, int start, params string[] values)
    {
        if (start + values.Length > tokens.Count)
            return false;
        for (var i = 0; i < values.Length; i++)
            if (!EqualsIgnoreCase(tokens[start + i].Text, values[i]))
                return false;
        return true;
    }

    private static bool EqualsIgnoreCase(string left, string right)
        => string.Equals(left, right, StringComparison.OrdinalIgnoreCase);

    private static string JoinName(string? parent, string name)
        => string.IsNullOrWhiteSpace(parent) ? name : parent + "." + name;

    private static string LastName(string fullName)
        => fullName.Split('.').Last();

    private static string FileSymbol(string relativePath)
        => "file:" + relativePath.Replace('\\', '/');

    private sealed record SymbolRange(int Start, int End, string FullName, string Kind);
}
