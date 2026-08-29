using AiCodeControl.Core.Services;
using Microsoft.Data.Sqlite;
using Xunit;

namespace AiCodeControl.Tests;

public sealed class DatabaseMigrationTests
{
    [Fact]
    public void InitializeCodegraph_UpgradesLegacyReferencesTable()
    {
        var root = Path.Combine(Path.GetTempPath(), "acc-db-migration-tests", Guid.NewGuid().ToString("N"));
        var database = Path.Combine(root, ".ai-code-control", "db", "codegraph.sqlite");
        Directory.CreateDirectory(Path.GetDirectoryName(database)!);
        try
        {
            using (var connection = new SqliteConnection($"Data Source={database}"))
            {
                connection.Open();
                using var command = connection.CreateCommand();
                command.CommandText = @"
CREATE TABLE references_map (
 id INTEGER PRIMARY KEY,
 symbol_full_name TEXT NOT NULL,
 referenced_from_symbol TEXT NULL,
 file_id INTEGER NOT NULL,
 line INTEGER NOT NULL,
 column INTEGER NOT NULL,
 reference_kind TEXT NOT NULL
);";
                command.ExecuteNonQuery();
            }

            new DatabaseInitializer().InitializeCodegraph(root, database);

            using var upgraded = new SqliteConnection($"Data Source={database}");
            upgraded.Open();
            using var pragma = upgraded.CreateCommand();
            pragma.CommandText = "PRAGMA table_info(references_map)";
            using var reader = pragma.ExecuteReader();
            var columns = new List<string>();
            while (reader.Read()) columns.Add(reader.GetString(1));
            Assert.Contains("reference_token", columns);
        }
        finally
        {
            SqliteConnection.ClearAllPools();
            try { Directory.Delete(root, recursive: true); } catch { }
        }
    }

    [Fact]
    public void InitializeCodegraph_AddsTraceSchemaIdempotentlyWithoutChangingCodeEdges()
    {
        var root = Path.Combine(Path.GetTempPath(), "acc-trace-migration-tests", Guid.NewGuid().ToString("N"));
        var database = Path.Combine(root, ".ai-code-control", "db", "codegraph.sqlite");
        Directory.CreateDirectory(Path.GetDirectoryName(database)!);
        try
        {
            var initializer = new DatabaseInitializer();
            initializer.InitializeCodegraph(root, database);
            using (var connection = new SqliteConnection($"Data Source={database}"))
            {
                connection.Open();
                using var insert = connection.CreateCommand();
                insert.CommandText = "INSERT INTO edges(from_symbol,to_symbol,edge_type,file_id) VALUES('A','B','calls',NULL)";
                insert.ExecuteNonQuery();
            }

            initializer.InitializeCodegraph(root, database);
            initializer.InitializeCodegraph(root, database);

            using var upgraded = new SqliteConnection($"Data Source={database}");
            upgraded.Open();
            Assert.Equal(1L, Scalar(upgraded, "SELECT COUNT(*) FROM edges"));
            Assert.Equal(1L, Scalar(upgraded, "SELECT COUNT(*) FROM schema_version WHERE version=3"));
            Assert.Equal(3L, Scalar(upgraded, "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name IN ('trace_nodes','trace_edges','trace_ingest_runs')"));
            using var invalidEdge = upgraded.CreateCommand();
            invalidEdge.CommandText = @"
INSERT INTO trace_edges(edge_id,from_node_id,to_node_id,edge_type,origin,confidence,trust_tier,evidence_ref,source_namespace,source_hash,source_commit,valid_from,valid_to,properties_json)
VALUES('edge','from','to','caused','manifest','declared','T1','evidence://fixture','fixture',$hash,'commit','2026-08-28T00:00:00.0000000+00:00',NULL,'{}');";
            invalidEdge.Parameters.AddWithValue("$hash", new string('a', 64));
            Assert.Throws<SqliteException>(() => invalidEdge.ExecuteNonQuery());
        }
        finally
        {
            SqliteConnection.ClearAllPools();
            try { Directory.Delete(root, recursive: true); } catch { }
        }
    }

    private static long Scalar(SqliteConnection connection, string sql)
    {
        using var command = connection.CreateCommand();
        command.CommandText = sql;
        return (long)(command.ExecuteScalar() ?? 0L);
    }
}
