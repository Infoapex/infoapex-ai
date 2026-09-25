using System.Text.Json;
using AiCodeControl.Core.Services;
using AiCodeControl.RustIndexer.Services;
using Microsoft.Data.Sqlite;
using Xunit;

namespace AiCodeControl.Tests;

public sealed class RustIndexerTests : IDisposable
{
    private readonly string root = Path.Combine(Path.GetTempPath(), "acc-rust-fixture", Guid.NewGuid().ToString("N"));
    private readonly string database;

    public RustIndexerTests()
    {
        Directory.CreateDirectory(root);
        database = new DatabaseInitializer().InitializeCodegraph(root);
        Write("Cargo.toml", "[workspace]\nmembers = [\"crates/*\"]\n");
        Write("crates/domain/Cargo.toml", "[package]\nname = \"domain\"\nversion = \"0.1.0\"\n");
        Write("crates/consumer/Cargo.toml", "[package]\nname = \"consumer\"\nversion = \"0.1.0\"\n[dependencies]\ndomain = { path = \"../domain\" }\n");
        Write("crates/other/Cargo.toml", "[package]\nname = \"other\"\nversion = \"0.1.0\"\n");
        Write("crates/domain/src/lib.rs", """
            pub struct ReadyBatch { pub id: u64 }
            pub struct ParamOnly;
            pub struct FieldOnly;
            pub struct ReturnOnly;
            pub trait BatchRepository { fn save(&self, batch: ReadyBatch) -> Result<ReadyBatch, E>; }
            pub struct E;
            pub fn dispatch(batch: ReadyBatch) -> ReadyBatch { batch }
            """);
        Write("crates/consumer/src/lib.rs", """
            use domain::{ReadyBatch as Batch, BatchRepository, ParamOnly, FieldOnly, ReturnOnly, E};
            pub struct Holder { pub value: Option<Batch> }
            pub struct FieldHolder { pub value: Vec<FieldOnly> }
            pub struct PgRepository;
            impl BatchRepository for PgRepository {
                fn save(&self, batch: Batch) -> Result<Batch, E> { Ok(domain::dispatch(batch)) }
            }
            impl PgRepository { pub fn new() -> Self { Self } pub fn ping(&self) {} pub fn touch(&self) { self.ping(); } }
            pub fn accept(batch: Batch) -> Option<Batch> { Some(batch) }
            pub fn param_only(value: ParamOnly) {}
            pub fn return_only() -> ReturnOnly { ReturnOnly }
            pub fn ambiguous(batch: ReadyBatch) {}
            """);
        Write("crates/other/src/lib.rs", """
            pub struct ReadyBatch;
            pub fn ambiguous(batch: ReadyBatch) {}
            pub fn unresolved(batch: MissingBatch) {}
            """);
    }

    [Fact]
    public void Index_BuildsTypedCrossCrateGraphAndKeepsAmbiguityExplicit()
    {
        var indexer = new RustIndexerService();
        var first = indexer.Index(root, ".", database);
        var edgesAfterFirst = Total("edges");
        var second = indexer.Index(root, ".", database);
        Assert.Equal(edgesAfterFirst, Total("edges"));
        Assert.Equal(3, first.CratesIndexed);
        Assert.Equal(first.EdgesIndexed, second.EdgesIndexed);
        Assert.Equal(2, SymbolCount("ReadyBatch"));
        Assert.Equal(1, SymbolCount("BatchRepository"));
        Assert.Equal(1, SymbolCount("accept"));
        Assert.Equal(2, SymbolCount("save"));
        Assert.Equal(2, SymbolCount("impl"));

        var impact = JsonSerializer.SerializeToElement(new SymbolQueryService().ImpactAnalysis(database, "domain::ReadyBatch"));
        Assert.Equal("ok", impact.GetProperty("status").GetString());
        var edges = impact.GetProperty("impacts").EnumerateArray().ToArray();
        Assert.Contains(edges, e => e.GetProperty("edgeType").GetString() == "uses_type" && e.GetProperty("from").GetString() == "consumer::Holder");
        Assert.Contains(edges, e => e.GetProperty("edgeType").GetString() == "uses_type" && e.GetProperty("from").GetString() == "consumer::accept");
        Assert.Contains(edges, e => e.GetProperty("edgeType").GetString() == "imports" && e.GetProperty("from").GetString() == "consumer");
        Assert.Contains(edges, e => e.GetProperty("edgeType").GetString() == "uses_type" && e.GetProperty("from").GetString() == "domain::BatchRepository::save");
        Assert.Contains(edges, e => e.GetProperty("edgeType").GetString() == "calls" && e.GetProperty("from").GetString()!.Contains("save", StringComparison.Ordinal));

        var dispatchImpact = JsonSerializer.SerializeToElement(new SymbolQueryService().ImpactAnalysis(database, "domain::dispatch"));
        Assert.Contains(dispatchImpact.GetProperty("impacts").EnumerateArray(), e => e.GetProperty("edgeType").GetString() == "calls" && e.GetProperty("from").GetString()!.EndsWith("::save", StringComparison.Ordinal));
        var ping = SymbolFullName("ping");
        var pingImpact = JsonSerializer.SerializeToElement(new SymbolQueryService().ImpactAnalysis(database, ping));
        Assert.Contains(pingImpact.GetProperty("impacts").EnumerateArray(), e => e.GetProperty("edgeType").GetString() == "calls" && e.GetProperty("from").GetString()!.EndsWith("::touch", StringComparison.Ordinal));
        var paramImpact = JsonSerializer.SerializeToElement(new SymbolQueryService().ImpactAnalysis(database, "domain::ParamOnly"));
        Assert.Contains(paramImpact.GetProperty("impacts").EnumerateArray(), e => e.GetProperty("from").GetString() == "consumer::param_only" && e.GetProperty("edgeType").GetString() == "uses_type");
        var fieldImpact = JsonSerializer.SerializeToElement(new SymbolQueryService().ImpactAnalysis(database, "domain::FieldOnly"));
        Assert.Contains(fieldImpact.GetProperty("impacts").EnumerateArray(), e => e.GetProperty("from").GetString() == "consumer::FieldHolder" && e.GetProperty("edgeType").GetString() == "uses_type");
        var returnImpact = JsonSerializer.SerializeToElement(new SymbolQueryService().ImpactAnalysis(database, "domain::ReturnOnly"));
        Assert.Contains(returnImpact.GetProperty("impacts").EnumerateArray(), e => e.GetProperty("from").GetString() == "consumer::return_only" && e.GetProperty("edgeType").GetString() == "uses_type");
        var traitImpact = JsonSerializer.SerializeToElement(new SymbolQueryService().ImpactAnalysis(database, "domain::BatchRepository"));
        Assert.Contains(traitImpact.GetProperty("impacts").EnumerateArray(), e => e.GetProperty("edgeType").GetString() == "implements");
        Assert.Equal("ambiguous", JsonSerializer.SerializeToElement(new SymbolQueryService().ImpactAnalysis(database, "ReadyBatch")).GetProperty("status").GetString());
        Assert.Equal(0, EdgeCount("consumer::ambiguous", "domain::ReadyBatch"));
        Assert.True(ReferenceCount("unresolved::ReadyBatch") > 0);

        File.Delete(Path.Combine(root, "crates", "other", "src", "lib.rs"));
        indexer.Index(root, ".", database);
        Assert.Equal(1, SymbolCount("ReadyBatch"));
    }

    private int Total(string table)
    {
        using var connection = new SqliteConnection($"Data Source={database}");
        connection.Open();
        using var command = connection.CreateCommand();
        command.CommandText = table == "edges" ? "SELECT COUNT(*) FROM edges" : throw new ArgumentException(nameof(table));
        return Convert.ToInt32(command.ExecuteScalar());
    }
    private string SymbolFullName(string name)
    {
        using var connection = new SqliteConnection($"Data Source={database}");
        connection.Open();
        using var command = connection.CreateCommand();
        command.CommandText = "SELECT full_name FROM symbols WHERE name = $name LIMIT 1";
        command.Parameters.AddWithValue("$name", name);
        return (string)command.ExecuteScalar()!;
    }
    private int SymbolCount(string name) => Scalar("SELECT COUNT(*) FROM symbols WHERE name = $value", name);
    private int ReferenceCount(string name) => Scalar("SELECT COUNT(*) FROM references_map WHERE symbol_full_name = $value", name);
    private int EdgeCount(string from, string to)
    {
        using var connection = new SqliteConnection($"Data Source={database}");
        connection.Open();
        using var command = connection.CreateCommand();
        command.CommandText = "SELECT COUNT(*) FROM edges WHERE from_symbol = $from AND to_symbol = $to";
        command.Parameters.AddWithValue("$from", from);
        command.Parameters.AddWithValue("$to", to);
        return Convert.ToInt32(command.ExecuteScalar());
    }
    private int Scalar(string sql, string value)
    {
        using var connection = new SqliteConnection($"Data Source={database}");
        connection.Open();
        using var command = connection.CreateCommand();
        command.CommandText = sql;
        command.Parameters.AddWithValue("$value", value);
        return Convert.ToInt32(command.ExecuteScalar());
    }
    private void Write(string relative, string content)
    {
        var path = Path.Combine(root, relative);
        Directory.CreateDirectory(Path.GetDirectoryName(path)!);
        File.WriteAllText(path, content);
    }
    public void Dispose()
    {
        SqliteConnection.ClearAllPools();
        Directory.Delete(root, true);
    }
}
