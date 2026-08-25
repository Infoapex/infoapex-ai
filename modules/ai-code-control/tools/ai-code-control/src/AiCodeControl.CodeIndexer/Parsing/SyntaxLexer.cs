using System.Text;
using AiCodeControl.CodeIndexer.Models;

namespace AiCodeControl.CodeIndexer.Parsing;

internal static class SyntaxLexer
{
    public static List<SyntaxToken> Tokenize(string content, string language)
    {
        var tokens = new List<SyntaxToken>();
        var i = 0;
        var line = 1;
        var column = 1;

        while (i < content.Length)
        {
            var ch = content[i];

            if (ch == '\r' || ch == '\n')
            {
                if (ch == '\r' && i + 1 < content.Length && content[i + 1] == '\n')
                    i++;
                i++;
                line++;
                column = 1;
                continue;
            }

            if (char.IsWhiteSpace(ch))
            {
                i++;
                column++;
                continue;
            }

            if (ch == '/' && i + 1 < content.Length && content[i + 1] == '/')
            {
                SkipLineComment(content, ref i, ref column);
                continue;
            }

            if (ch == '/' && i + 1 < content.Length && content[i + 1] == '*')
            {
                SkipBlockComment(content, ref i, ref line, ref column);
                continue;
            }

            if (language == "sql" && ch == '-' && i + 1 < content.Length && content[i + 1] == '-')
            {
                SkipLineComment(content, ref i, ref column);
                continue;
            }

            if (language == "sql" && ch == '/' && i + 1 < content.Length && content[i + 1] == '*')
            {
                SkipBlockComment(content, ref i, ref line, ref column);
                continue;
            }

            if (ch is '\'' or '"' or '`')
            {
                tokens.Add(ReadQuoted(content, ref i, ref line, ref column, ch, language));
                continue;
            }

            if (char.IsLetter(ch) || ch is '_' or '$' || (language == "sql" && ch == '['))
            {
                tokens.Add(ReadIdentifier(content, ref i, ref column, line, language));
                continue;
            }

            if (char.IsDigit(ch))
            {
                var start = i;
                var startColumn = column;
                while (i < content.Length && (char.IsLetterOrDigit(content[i]) || content[i] is '.' or '_'))
                {
                    i++;
                    column++;
                }
                tokens.Add(new SyntaxToken(content[start..i], line, startColumn, SyntaxTokenKind.Number));
                continue;
            }

            var two = i + 1 < content.Length ? content.Substring(i, 2) : string.Empty;
            if (two is "=>" or "::" or "?." or "??" or "==" or "!=" or "<=" or ">=" or "&&" or "||")
            {
                tokens.Add(new SyntaxToken(two, line, column, SyntaxTokenKind.Symbol));
                i += 2;
                column += 2;
                continue;
            }

            tokens.Add(new SyntaxToken(ch.ToString(), line, column, SyntaxTokenKind.Symbol));
            i++;
            column++;
        }

        return tokens;
    }

    private static SyntaxToken ReadQuoted(
        string content,
        ref int index,
        ref int line,
        ref int column,
        char quote,
        string language)
    {
        var startLine = line;
        var startColumn = column;
        var sb = new StringBuilder();
        index++;
        column++;

        while (index < content.Length)
        {
            var ch = content[index];
            if (ch == '\\' && language != "sql" && index + 1 < content.Length)
            {
                sb.Append(content[index + 1]);
                index += 2;
                column += 2;
                continue;
            }

            if (ch == quote)
            {
                if (language == "sql" && index + 1 < content.Length && content[index + 1] == quote)
                {
                    sb.Append(quote);
                    index += 2;
                    column += 2;
                    continue;
                }
                index++;
                column++;
                break;
            }

            if (ch is '\r' or '\n')
            {
                if (ch == '\r' && index + 1 < content.Length && content[index + 1] == '\n')
                    index++;
                index++;
                line++;
                column = 1;
                sb.Append('\n');
                continue;
            }

            sb.Append(ch);
            index++;
            column++;
        }

        var kind = language == "sql" && quote == '"' ? SyntaxTokenKind.Identifier : SyntaxTokenKind.String;
        return new SyntaxToken(sb.ToString(), startLine, startColumn, kind);
    }

    private static SyntaxToken ReadIdentifier(
        string content,
        ref int index,
        ref int column,
        int line,
        string language)
    {
        var start = index;
        var startColumn = column;

        if (language == "sql" && content[index] == '[')
        {
            index++;
            column++;
            start = index;
            while (index < content.Length && content[index] != ']')
            {
                index++;
                column++;
            }
            var value = content[start..index];
            if (index < content.Length)
            {
                index++;
                column++;
            }
            return new SyntaxToken(value, line, startColumn, SyntaxTokenKind.Identifier);
        }

        while (index < content.Length && (char.IsLetterOrDigit(content[index]) || content[index] is '_' or '$'))
        {
            index++;
            column++;
        }

        return new SyntaxToken(content[start..index], line, startColumn, SyntaxTokenKind.Identifier);
    }

    private static void SkipLineComment(string content, ref int index, ref int column)
    {
        while (index < content.Length && content[index] is not '\r' and not '\n')
        {
            index++;
            column++;
        }
    }

    private static void SkipBlockComment(string content, ref int index, ref int line, ref int column)
    {
        index += 2;
        column += 2;
        while (index < content.Length)
        {
            if (index + 1 < content.Length && content[index] == '*' && content[index + 1] == '/')
            {
                index += 2;
                column += 2;
                return;
            }

            if (content[index] is '\r' or '\n')
            {
                if (content[index] == '\r' && index + 1 < content.Length && content[index + 1] == '\n')
                    index++;
                index++;
                line++;
                column = 1;
            }
            else
            {
                index++;
                column++;
            }
        }
    }
}
