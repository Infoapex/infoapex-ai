using AiCodeControl.CodeIndexer.Services;
using AiCodeControl.Core.Models;
using AiCodeControl.Core.Services;
using Microsoft.Data.Sqlite;
using Xunit;

namespace AiCodeControl.Tests;

public sealed class TraceGraphIngestServiceTests : IDisposable
{
    private readonly string _root;
    private readonly string _database;

    public TraceGraphIngestServiceTests()
    {
        _root = Path.Combine(Path.GetTempPath(), "acc-trace-ingest-tests", Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(_root);
        Write("src/Service.cs", "namespace Demo; public class Service { public void Run() { } } public class Other { public void Run() { } }");
        _database = new DatabaseInitializer().InitializeCodegraph(_root);
        new CodeIndexerService().Index(_root, ".", _database, fullRebuild: true);
    }

    [Fact]
    public void Build_ProducesOnlyDeclaredEdgesAndPreservesProposedAuthorityAndAmbiguity()
    {
        var documents = Fixtures();
        var result = new TraceGraphIngestService().Build(Request(documents));

        Assert.Equal(documents.Count, result.DocumentsRead);
        Assert.Equal(0, result.DocumentsSkipped);
        Assert.Contains(result.Diagnostics, item => item.Code == "SYMBOL_AMBIGUOUS");
        var proposed = result.Snapshot.Nodes.Single(item => item.NodeType == "adr" && item.CanonicalRef == "ADR-0003");
        Assert.Equal("proposed", proposed.Authority);
        Assert.DoesNotContain(result.Snapshot.Edges, edge => edge.EdgeType == "caused");
        Assert.All(result.Snapshot.Edges, edge =>
        {
            Assert.False(string.IsNullOrWhiteSpace(edge.EvidenceRef));
            Assert.Contains(edge.TrustTier, new[] { "T0", "T1" });
        });

        var actual = result.Snapshot.Edges.Select(edge => Triple(edge.EdgeType, edge.FromNodeId, edge.ToNodeId))
            .ToHashSet(StringComparer.Ordinal);
        var expected = new HashSet<string>(StringComparer.Ordinal)
        {
            Triple("supersedes", Id("adr", "ADR-0002"), Id("adr", "ADR-0001")),
            Triple("references", Id("contract", "contracts/sample.schema.json"), Id("criterion", "AC-CONTRACT")),
            Triple("implements", Id("task", "TASK-1"), Id("criterion", "AC-1")),
            Triple("verified_by", Id("criterion", "AC-1"), Id("gate", "G-1")),
            Triple("selected_for", Id("contract", "contracts/sample.schema.json"), Id("task", "TASK-1")),
            Triple("verified_by", Id("gate", "G-1"), Id("evidence", "tasks/TASK-1/evidence.json#gate:G-1")),
            Triple("implements", Id("file", "src/Service.cs"), Id("task", "TASK-1")),
            Triple("derived_from", Id("context-package", new string('9', 64)), Id("contract", "contracts/sample.schema.json")),
            Triple("references", Id("adr", "ADR-0002"), Id("contract", "contracts/sample.schema.json"))
        };
        Assert.Equal(expected, actual);
    }

    [Fact]
    public void Rebuild_IsDeterministicAndIncrementalHashingDoesNotRewriteUnchangedEntities()
    {
        var service = new TraceGraphIngestService();
        var repository = new TraceGraphRepository();
        var documents = Fixtures();
        var first = service.Rebuild(Request(documents), repository);
        var second = service.Rebuild(Request(documents.AsEnumerable().Reverse().ToList()), repository);
        Assert.Equal(first.State.Digest, second.State.Digest);

        Write("docs/adr/ADR-0002.md", "# Renamed current decision\n\n**Status:** Accepted\n\nSupersedes: ADR-0001\n");
        var changedRequest = Request(documents) with
        {
            SourceCommit = new string('2', 40),
            EffectiveAt = DateTimeOffset.Parse("2026-08-28T15:05:00Z")
        };
        var changed = service.Build(changedRequest);
        var write = repository.ApplySnapshot(_database, changed.Snapshot);

        Assert.Equal(1, write.NodesInserted);
        Assert.Equal(1, write.NodesExpired);
        Assert.Equal(1, write.EdgesInserted);
        Assert.Equal(1, write.EdgesExpired);
        Assert.Equal("Renamed current decision", repository.ReadCurrent(_database).Nodes
            .Single(item => item.NodeType == "adr" && item.CanonicalRef == "ADR-0002").Title);
    }

    [Fact]
    public void Rebuild_FailsClosedOnBlockingDocumentDiagnostics()
    {
        var missing = new TraceIngestDocument("contract", Path.Combine(_root, "missing.json"), "contracts/missing.json");
        var service = new TraceGraphIngestService();
        var request = Request([missing]);
        var built = service.Build(request);
        Assert.Contains(built.Diagnostics, item => item.Code == "DOCUMENT_MISSING" && item.Severity == "error");
        Assert.Throws<InvalidOperationException>(() => service.Rebuild(request, new TraceGraphRepository()));
    }

    [Fact]
    public void Build_ReadsCriteriaAndGatesFromWorkerManifestV11Traceability()
    {
        Write("Plan/worker-v11.json", """
        { "schemaVersion":"1.1", "tasks":[{
          "id":"TASK-V11", "acceptanceCriteria":["It works"], "gates":[],
          "traceability":{
            "acceptanceCriteria":[{"criterionId":"AC-V11","text":"It works"}],
            "gates":[{"gateId":"G-V11","command":"test","evidenceContract":"pass","criterionIds":["AC-V11"]}]
          },
          "dependsOn":[], "requiredInputs":[]
        }] }
        """);

        var result = new TraceGraphIngestService().Build(Request([Doc("plan", "Plan/worker-v11.json")]));

        Assert.Equal(1, result.DocumentsRead);
        Assert.Equal(0, result.DocumentsSkipped);
        Assert.Contains(result.Snapshot.Nodes, node => node.NodeType == "criterion" && node.CanonicalRef == "AC-V11");
        Assert.Contains(result.Snapshot.Nodes, node => node.NodeType == "gate" && node.CanonicalRef == "G-V11");
        Assert.Contains(result.Snapshot.Edges, edge => edge.EdgeType == "implements");
        Assert.Contains(result.Snapshot.Edges, edge => edge.EdgeType == "verified_by");
    }

    private List<TraceIngestDocument> Fixtures()
    {
        Write("docs/adr/ADR-0001.md", "# Old decision\n\n**Status:** Accepted\n");
        Write("docs/adr/ADR-0002.md", "# Current decision\n\n- **Status**: acceptat\n\nSupersedes: ADR-0001\n");
        Write("docs/adr/ADR-0003.md", "# Draft decision\n\n**Status:** Proposed\n");
        Write("contracts/sample.schema.json", """
        { "$id": "contracts/sample.schema.json", "title": "Sample contract", "$defs": { "criterion": { "criterionId": "AC-CONTRACT" } } }
        """);
        Write("Plan/plan.json", """
        { "goal":"fixture", "tasks":[{"id":"TASK-1","goal":"Implement fixture","acceptanceCriteria":[{"criterionId":"AC-1","text":"It works"}],"gates":[{"gateId":"G-1","command":"test","evidenceContract":"pass","criterionIds":["AC-1"]}],"dependsOn":[],"requiredInputs":[{"kind":"file","ref":"contracts/sample.schema.json"}]}] }
        """);
        Write("runs/source-map.v1.json", $$"""
        { "schemaVersion":"1.0", "runId":"run-1", "manifestSha256":"{{new string('a',64)}}", "nodes":[
          {"nodeId":"n-task","kind":"task","canonicalRef":"task:TASK-1","authority":"canonical"},
          {"nodeId":"n-criterion","kind":"criterion","canonicalRef":"criterion:AC-1","authority":"canonical"},
          {"nodeId":"n-gate","kind":"gate","canonicalRef":"gate:G-1","authority":"canonical"},
          {"nodeId":"n-evidence","kind":"evidence","canonicalRef":"tasks/TASK-1/evidence.json#gate:G-1","authority":"generated"},
          {"nodeId":"n-file","kind":"file","canonicalRef":"src/Service.cs","authority":"canonical"},
          {"nodeId":"n-symbol","kind":"symbol","canonicalRef":"Run","authority":"canonical"}
        ], "edges":[
          {"edgeId":"e1","relation":"implemented_by","fromNodeId":"n-criterion","toNodeId":"n-task","confidence":"declared","evidenceRefs":["manifest.json"]},
          {"edgeId":"e2","relation":"verified_by","fromNodeId":"n-criterion","toNodeId":"n-gate","confidence":"declared","evidenceRefs":["manifest.json"]},
          {"edgeId":"e3","relation":"verified_by","fromNodeId":"n-gate","toNodeId":"n-evidence","confidence":"observed","evidenceRefs":["tasks/TASK-1/evidence.json"]},
          {"edgeId":"e4","relation":"implemented_by","fromNodeId":"n-task","toNodeId":"n-file","confidence":"observed","evidenceRefs":["events.jsonl"]}
        ], "coverage":{"criteriaTotal":1,"criteriaWithDirectEvidence":1,"traceCoveragePercent":100,"complete":true}, "findings":[], "sourceMapDigest":"{{new string('8',64)}}", "createdAt":"2026-08-28T15:00:00Z" }
        """);
        Write("runs/context-package.v1.json", $$"""
        { "schemaVersion":"1.0", "packageId":"ctx-1", "runId":"run-1", "taskId":"TASK-1", "manifestSha256":"{{new string('a',64)}}", "compilerVersion":"1.0", "sources":[{"sourceId":"s1","sourceType":"contract","canonicalRef":"contracts/sample.schema.json","sourceHash":"{{new string('b',64)}}","sourceCommit":null,"authority":"canonical","selectionReason":"required","renderedContent":"{}"}], "budget":{"measurement":"tokenizer","maximumTokens":100,"estimatedTokens":1,"omittedSources":[]}, "diagnostics":[], "contextDigest":"{{new string('9',64)}}", "createdAt":"2026-08-28T15:00:00Z" }
        """);
        Write("contracts/trace-relations.json", """
        { "schemaVersion":"1.0", "relations":[{"from":{"type":"adr","canonicalRef":"ADR-0002"},"relation":"references","to":{"type":"contract","canonicalRef":"contracts/sample.schema.json"},"evidenceRef":"contracts/trace-relations.json"}] }
        """);

        return
        [
            Doc("adr", "docs/adr/ADR-0001.md"), Doc("adr", "docs/adr/ADR-0002.md"),
            Doc("adr", "docs/adr/ADR-0003.md"), Doc("contract", "contracts/sample.schema.json"),
            Doc("plan", "Plan/plan.json"), Doc("source-map", "runs/source-map.v1.json"),
            Doc("context-package", "runs/context-package.v1.json"), Doc("relations", "contracts/trace-relations.json")
        ];
    }

    private TraceGraphIngestRequest Request(IReadOnlyList<TraceIngestDocument> documents)
        => new(_root, _database, new string('1', 40), DateTimeOffset.Parse("2026-08-28T15:00:00Z"), documents);
    private TraceIngestDocument Doc(string kind, string relative) => new(kind, Path.Combine(_root, relative.Replace('/', Path.DirectorySeparatorChar)), relative);
    private void Write(string relative, string content)
    {
        var path = Path.Combine(_root, relative.Replace('/', Path.DirectorySeparatorChar));
        Directory.CreateDirectory(Path.GetDirectoryName(path)!); File.WriteAllText(path, content);
    }
    private static string Id(string type, string canonical) => TraceGraphRepository.ComputeNodeId(type, canonical);
    private static string Triple(string relation, string from, string to) => $"{relation}|{from}|{to}";

    public void Dispose()
    {
        SqliteConnection.ClearAllPools();
        try { Directory.Delete(_root, recursive: true); } catch { }
    }
}
