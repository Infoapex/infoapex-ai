namespace AiCodeControl.PythonIndexer.Models;

public sealed record IndexedSymbol(
    string Name,
    string FullName,
    string Kind,
    int StartLine,
    int EndLine,
    string? ParentSymbol,
    string? Accessibility = null);

public sealed record IndexedReference(
    string SymbolToken,
    string? ReferencedFromSymbol,
    int Line,
    int Column,
    string ReferenceKind);

public sealed record IndexedImport(
    string Module,
    string? ImportedName,
    string? Alias,
    int Line);

public sealed record PythonFileIndex(
    string RelativePath,
    string Hash,
    List<IndexedSymbol> Symbols,
    List<IndexedReference> References,
    List<IndexedImport> Imports);

public sealed record PythonIndexResult(
    int FilesIndexed,
    int SymbolsIndexed,
    int ReferencesIndexed,
    int EdgesIndexed,
    int ImportsIndexed);
