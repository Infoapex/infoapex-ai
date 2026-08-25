namespace AiCodeControl.Memory.Services;

/// <summary>
/// Offline, dependency-free token estimator. Approximates GPT/Claude BPE token
/// counts by blending a character-based and a word-based signal. Accuracy is
/// within roughly 10-15% on mixed Markdown/code; it exists for relative
/// measurement (before/after) and budgeting, not exact billing. Deterministic
/// and allocation-light so it is safe to call over the whole memory store.
/// </summary>
public static class TokenEstimator
{
    public static int Estimate(string? text)
    {
        if (string.IsNullOrEmpty(text))
            return 0;

        var words = 0;
        var nonSpace = 0;
        var inWord = false;

        foreach (var ch in text)
        {
            if (char.IsLetterOrDigit(ch))
            {
                nonSpace++;
                if (!inWord)
                {
                    words++;
                    inWord = true;
                }
            }
            else
            {
                inWord = false;
                if (!char.IsWhiteSpace(ch))
                    nonSpace++; // punctuation feeds the character signal
            }
        }

        if (words == 0 && nonSpace == 0)
            return 0;

        // Character signal: ~4 non-space chars per token (common English approximation).
        var charEstimate = nonSpace / 4.0;
        // Word signal: ~1.33 tokens per word (sub-word splits + trailing punctuation).
        var wordEstimate = words * 1.33;

        var blended = (charEstimate + wordEstimate) / 2.0;
        return Math.Max(1, (int)Math.Ceiling(blended));
    }
}
