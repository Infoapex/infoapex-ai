namespace AiCodeControl.CodeIndexer.Models;

public sealed record SyntaxToken(string Text, int Line, int Column, SyntaxTokenKind Kind);

public enum SyntaxTokenKind
{
    Identifier,
    Number,
    String,
    Symbol
}

public sealed record CodeSymbol(
    string Name,
    string FullName,
    string Kind,
    int StartLine,
    int EndLine,
    string? ParentSymbol,
    string? Accessibility = null);

public sealed record CodeReference(
    string Token,
    string? ReferencedFromSymbol,
    int Line,
    int Column,
    string Kind);

public sealed record ParsedCodeFile(
    string RelativePath,
    string Language,
    string Hash,
    List<CodeSymbol> Symbols,
    List<CodeReference> References);

public sealed record CodeIndexResult(
    string Mode,
    int FilesDiscovered,
    int FilesIndexed,
    int FilesSkipped,
    int FilesPruned,
    int SymbolsIndexed,
    int ReferencesIndexed,
    int EdgesRebuilt,
    string? Branch,
    string? Commit);
