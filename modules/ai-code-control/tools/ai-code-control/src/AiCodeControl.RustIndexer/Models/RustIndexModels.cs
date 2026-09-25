namespace AiCodeControl.RustIndexer.Models;

public sealed record RustSymbol(
    string Name,
    string FullName,
    string Kind,
    int StartLine,
    int EndLine,
    string? ParentSymbol,
    string? Accessibility = null);

public sealed record RustReference(
    string SymbolToken,
    string? ReferencedFromSymbol,
    int Line,
    int Column,
    string ReferenceKind,
    string EdgeType = "calls");

public sealed record RustImport(string Path, string LocalName, string ModuleName);

public sealed record RustFileIndex(
    string RelativePath,
    string Hash,
    List<RustSymbol> Symbols,
    List<RustReference> References,
    string CrateName,
    string ModuleName,
    List<RustImport> Imports);

public sealed record RustIndexResult(
    int CratesIndexed,
    int DependenciesIndexed,
    int FilesIndexed,
    int SymbolsIndexed,
    int ReferencesIndexed,
    int EdgesIndexed);
