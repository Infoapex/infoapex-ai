namespace AiCodeControl.Core.Models;

public sealed record SymbolQueryMatch(
    string Name,
    string FullName,
    string Kind,
    string Language,
    string File,
    int StartLine,
    int EndLine);
