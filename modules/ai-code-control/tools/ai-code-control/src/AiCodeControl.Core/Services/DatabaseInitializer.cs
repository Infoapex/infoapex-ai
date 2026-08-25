using Microsoft.Data.Sqlite;

namespace AiCodeControl.Core.Services;

public sealed class DatabaseInitializer
{
    public string InitializeCodegraph(string repoRoot, string? dbPath = null)
    {
        dbPath ??= Path.Combine(repoRoot, ".ai-code-control", "db", "codegraph.sqlite");
        Directory.CreateDirectory(Path.GetDirectoryName(dbPath)!);

        using var connection = new SqliteConnection($"Data Source={dbPath}");
        connection.Open();

        using var command = connection.CreateCommand();
        command.CommandText = @"
PRAGMA journal_mode=WAL;
PRAGMA synchronous=NORMAL;
PRAGMA foreign_keys=ON;
PRAGMA busy_timeout=10000;
PRAGMA temp_store=MEMORY;
PRAGMA cache_size=-64000;

CREATE TABLE IF NOT EXISTS schema_version (
    version INTEGER NOT NULL PRIMARY KEY,
    applied_at TEXT NOT NULL,
    description TEXT NULL
);
INSERT OR IGNORE INTO schema_version (version, applied_at, description)
VALUES (1, datetime('now'), 'Initial schema');
INSERT OR IGNORE INTO schema_version (version, applied_at, description)
VALUES (2, datetime('now'), 'Incremental multi-language index runs and raw reference tokens');

CREATE TABLE IF NOT EXISTS files (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    path TEXT NOT NULL UNIQUE,
    language TEXT NOT NULL,
    hash TEXT NOT NULL,
    indexed_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS symbols (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    file_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    full_name TEXT NOT NULL,
    kind TEXT NOT NULL,
    language TEXT NOT NULL,
    start_line INTEGER NOT NULL,
    end_line INTEGER NOT NULL,
    accessibility TEXT NULL,
    parent_symbol TEXT NULL,
    FOREIGN KEY(file_id) REFERENCES files(id)
);

CREATE TABLE IF NOT EXISTS references_map (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    symbol_full_name TEXT NOT NULL,
    referenced_from_symbol TEXT NULL,
    file_id INTEGER NOT NULL,
    line INTEGER NOT NULL,
    column INTEGER NOT NULL,
    reference_kind TEXT NOT NULL,
    reference_token TEXT NULL,
    FOREIGN KEY(file_id) REFERENCES files(id)
);

CREATE TABLE IF NOT EXISTS edges (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    from_symbol TEXT NOT NULL,
    to_symbol TEXT NOT NULL,
    edge_type TEXT NOT NULL,
    file_id INTEGER NULL
);

CREATE TABLE IF NOT EXISTS python_imports (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    file_id INTEGER NOT NULL,
    module TEXT NOT NULL,
    imported_name TEXT NULL,
    alias TEXT NULL,
    line INTEGER NOT NULL,
    FOREIGN KEY(file_id) REFERENCES files(id)
);

CREATE TABLE IF NOT EXISTS rust_crates (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    manifest_path TEXT NOT NULL,
    root_module TEXT NULL
);

CREATE TABLE IF NOT EXISTS rust_dependencies (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    crate_id INTEGER NOT NULL,
    dependency_name TEXT NOT NULL,
    dependency_kind TEXT NOT NULL,
    version_req TEXT NULL,
    FOREIGN KEY(crate_id) REFERENCES rust_crates(id)
);

CREATE TABLE IF NOT EXISTS code_index_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    started_at TEXT NOT NULL,
    completed_at TEXT NOT NULL,
    mode TEXT NOT NULL,
    scope TEXT NOT NULL,
    branch TEXT NULL,
    git_commit TEXT NULL,
    files_discovered INTEGER NOT NULL,
    files_indexed INTEGER NOT NULL,
    files_skipped INTEGER NOT NULL,
    files_pruned INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_files_path ON files(path);
CREATE INDEX IF NOT EXISTS idx_symbols_name ON symbols(name);
CREATE INDEX IF NOT EXISTS idx_symbols_full_name ON symbols(full_name);
CREATE INDEX IF NOT EXISTS idx_references_symbol ON references_map(symbol_full_name);
CREATE INDEX IF NOT EXISTS idx_edges_from ON edges(from_symbol);
CREATE INDEX IF NOT EXISTS idx_edges_to ON edges(to_symbol);
CREATE UNIQUE INDEX IF NOT EXISTS idx_rust_crates_manifest ON rust_crates(manifest_path);
CREATE INDEX IF NOT EXISTS idx_code_index_runs_completed ON code_index_runs(completed_at DESC);
";
        command.ExecuteNonQuery();

        EnsureColumn(connection, "references_map", "reference_token", "TEXT NULL");
        using var referenceIndex = connection.CreateCommand();
        referenceIndex.CommandText = "CREATE INDEX IF NOT EXISTS idx_references_token ON references_map(reference_token)";
        referenceIndex.ExecuteNonQuery();

        return dbPath;
    }

    public string InitializeMemory(string repoRoot, string? dbPath = null)
    {
        dbPath ??= Path.Combine(repoRoot, ".ai-code-control", "db", "memory.sqlite");
        Directory.CreateDirectory(Path.GetDirectoryName(dbPath)!);

        using var connection = new SqliteConnection($"Data Source={dbPath}");
        connection.Open();

        using var command = connection.CreateCommand();
        command.CommandText = @"
PRAGMA journal_mode=WAL;
PRAGMA synchronous=NORMAL;
PRAGMA foreign_keys=ON;
PRAGMA busy_timeout=10000;

CREATE TABLE IF NOT EXISTS memory_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source_path TEXT NOT NULL UNIQUE,
    title TEXT NULL,
    item_type TEXT NOT NULL,
    content TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(
    title,
    content,
    source_path,
    item_type,
    content='memory_items',
    content_rowid='id',
    tokenize='unicode61 remove_diacritics 2'
);

CREATE TRIGGER IF NOT EXISTS memory_items_ai AFTER INSERT ON memory_items BEGIN
    INSERT INTO memory_fts(rowid, title, content, source_path, item_type)
    VALUES (new.id, new.title, new.content, new.source_path, new.item_type);
END;

CREATE TRIGGER IF NOT EXISTS memory_items_ad AFTER DELETE ON memory_items BEGIN
    INSERT INTO memory_fts(memory_fts, rowid, title, content, source_path, item_type)
    VALUES('delete', old.id, old.title, old.content, old.source_path, old.item_type);
END;

CREATE TRIGGER IF NOT EXISTS memory_items_au AFTER UPDATE ON memory_items BEGIN
    INSERT INTO memory_fts(memory_fts, rowid, title, content, source_path, item_type)
    VALUES('delete', old.id, old.title, old.content, old.source_path, old.item_type);
    INSERT INTO memory_fts(rowid, title, content, source_path, item_type)
    VALUES (new.id, new.title, new.content, new.source_path, new.item_type);
END;

CREATE TABLE IF NOT EXISTS memory_ingest_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    completed_at TEXT NOT NULL,
    branch TEXT NULL,
    git_commit TEXT NULL,
    files_seen INTEGER NOT NULL,
    files_ingested INTEGER NOT NULL,
    files_skipped INTEGER NOT NULL,
    files_pruned INTEGER NOT NULL,
    errors INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_memory_ingest_runs_completed ON memory_ingest_runs(completed_at DESC);
";
        command.ExecuteNonQuery();

        return dbPath;
    }

    private static void EnsureColumn(SqliteConnection connection, string table, string column, string definition)
    {
        using var pragma = connection.CreateCommand();
        pragma.CommandText = $"PRAGMA table_info({table})";
        using var reader = pragma.ExecuteReader();
        while (reader.Read())
        {
            if (string.Equals(reader.GetString(1), column, StringComparison.OrdinalIgnoreCase))
                return;
        }

        reader.Close();
        using var alter = connection.CreateCommand();
        alter.CommandText = $"ALTER TABLE {table} ADD COLUMN {column} {definition}";
        alter.ExecuteNonQuery();
    }
}
