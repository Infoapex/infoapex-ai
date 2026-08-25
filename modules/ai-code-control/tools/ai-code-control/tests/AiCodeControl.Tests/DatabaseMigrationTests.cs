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
}
