using System.Text;
using System.Text.RegularExpressions;

namespace AiCodeControl.Memory.Services;

/// <summary>
/// Meaning-preserving Markdown compaction. Removes only text that carries no
/// token value - single-line HTML comments, trailing whitespace, standalone
/// horizontal rules and runs of blank lines - and leaves fenced code blocks
/// byte-for-byte intact. It never rewrites prose, so canonical intent is
/// preserved (ADR-0006); the canonical file on disk is never touched, this
/// only shapes the derived copy that the index and briefs draw from.
/// </summary>
public static class MarkdownCompactor
{
    private static readonly Regex HtmlComment =
        new(@"<!--.*?-->", RegexOptions.Singleline | RegexOptions.Compiled);

    public static string Compact(string? text)
    {
        if (string.IsNullOrEmpty(text))
            return string.Empty;

        var lines = Normalize(text).Split('\n');
        var builder = new StringBuilder();
        var inFence = false;
        var pendingBlank = false;
        var wroteAny = false;

        foreach (var rawLine in lines)
        {
            var startTrim = rawLine.TrimStart();
            if (startTrim.StartsWith("```", StringComparison.Ordinal) ||
                startTrim.StartsWith("~~~", StringComparison.Ordinal))
            {
                inFence = !inFence;
                FlushBlank(builder, ref pendingBlank, wroteAny);
                builder.Append(rawLine.TrimEnd()).Append('\n');
                wroteAny = true;
                continue;
            }

            if (inFence)
            {
                // Code is data: keep it exactly as written.
                FlushBlank(builder, ref pendingBlank, wroteAny);
                builder.Append(rawLine).Append('\n');
                wroteAny = true;
                continue;
            }

            var line = HtmlComment.Replace(rawLine, string.Empty).TrimEnd();

            if (line.Length == 0)
            {
                pendingBlank = true;
                continue;
            }

            if (IsHorizontalRule(line))
                continue;

            FlushBlank(builder, ref pendingBlank, wroteAny);
            builder.Append(line).Append('\n');
            wroteAny = true;
        }

        return builder.ToString().TrimEnd('\n');
    }

    /// <summary>
    /// Returns the leading lines of <paramref name="text"/> that fit within
    /// <paramref name="maxTokens"/>. Truncation, never rewriting - keeps whole
    /// lines so headings and bullets stay intact.
    /// </summary>
    public static string HeadByTokens(string? text, int maxTokens)
    {
        if (string.IsNullOrEmpty(text) || maxTokens <= 0)
            return string.Empty;
        if (TokenEstimator.Estimate(text) <= maxTokens)
            return text;

        var builder = new StringBuilder();
        var used = 0;
        foreach (var line in Normalize(text).Split('\n'))
        {
            var cost = TokenEstimator.Estimate(line + "\n");
            if (used + cost > maxTokens)
                break;
            builder.Append(line).Append('\n');
            used += cost;
        }

        return builder.ToString().TrimEnd('\n');
    }

    private static string Normalize(string text)
        => text.Replace("\r\n", "\n").Replace('\r', '\n');

    private static void FlushBlank(StringBuilder builder, ref bool pending, bool wroteAny)
    {
        if (pending && wroteAny)
            builder.Append('\n');
        pending = false;
    }

    private static bool IsHorizontalRule(string line)
    {
        var stripped = line.Replace(" ", string.Empty);
        if (stripped.Length < 3)
            return false;
        return stripped.All(c => c == '-')
            || stripped.All(c => c == '*')
            || stripped.All(c => c == '_');
    }
}
