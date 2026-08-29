using AiCodeControl.Core.Models;
using AiCodeControl.Core.Services;
using Microsoft.Data.Sqlite;
using Xunit;

namespace AiCodeControl.Tests;

public sealed class TraceGraphRepositoryTests : IDisposable
{
    private readonly string _root;
    private readonly string _database;
    private readonly TraceGraphRepository _repository = new();

    public TraceGraphRepositoryTests()
    {
        _root = Path.Combine(Path.GetTempPath(), "acc-trace-repository-tests", Guid.NewGuid().ToString("N"));
        _database = new DatabaseInitializer().InitializeCodegraph(_root);
    }

    [Fact]
    public void StableNodeId_DependsOnNamespaceAndCanonicalRef_NotTitle()
    {
        var before = TraceGraphRepository.ComputeNodeId("contract", "contracts/order.v1.json");
        var afterTitleChange = TraceGraphRepository.ComputeNodeId("contract", "contracts/order.v1.json");
        var otherNamespace = TraceGraphRepository.ComputeNodeId("adr", "contracts/order.v1.json");

        Assert.Equal(before, afterTitleChange);
        Assert.NotEqual(before, otherNamespace);
    }

    [Fact]
    public void ApplySnapshot_IsIdempotentAndKeepsExpiredVersionsOutOfCurrentState()
    {
        var firstAt = DateTimeOffset.Parse("2026-08-28T10:00:00Z");
        var secondAt = firstAt.AddMinutes(5);
        var contract = Node("contract", "contract", "contracts/order.v1.json", "Order v1", 'a');
        var criterion = Node("criterion", "criterion", "AC-001", "Original criterion", 'b');
        var contractId = TraceGraphRepository.ComputeNodeId(contract.NodeNamespace, contract.CanonicalRef);
        var criterionId = TraceGraphRepository.ComputeNodeId(criterion.NodeNamespace, criterion.CanonicalRef);
        var edge = Edge(contractId, criterionId, "references", "manifest", "declared", "T1", 'c');

        var first = _repository.ApplySnapshot(_database, Snapshot("contracts", '1', firstAt, [contract, criterion], [edge]));
        Assert.Equal(2, first.NodesInserted);
        Assert.Equal(1, first.EdgesInserted);

        var renamed = criterion with { Title = "Renamed criterion", SourceHash = Hash('d') };
        var second = _repository.ApplySnapshot(_database, Snapshot("contracts", '2', secondAt, [renamed], []));
        Assert.Equal(1, second.NodesInserted);
        Assert.Equal(2, second.NodesExpired);
        Assert.Equal(1, second.EdgesExpired);

        var current = _repository.ReadCurrent(_database);
        Assert.Single(current.Nodes);
        Assert.Empty(current.Edges);
        Assert.Equal(criterionId, current.Nodes[0].NodeId);
        Assert.Equal("Renamed criterion", current.Nodes[0].Title);

        var history = _repository.ReadHistory(_database);
        Assert.Equal(3, history.Nodes.Count);
        Assert.Single(history.Edges);
        Assert.Equal(secondAt, history.Edges[0].ValidTo);

        var repeated = _repository.ApplySnapshot(_database, Snapshot("contracts", '2', secondAt.AddMinutes(1), [renamed], []));
        Assert.Equal(0, repeated.NodesInserted);
        Assert.Equal(0, repeated.NodesExpired);
        Assert.Equal(current.Digest, repeated.CurrentDigest);
    }

    [Fact]
    public void ApplySnapshot_ValidatesVocabularyTierConfidenceEvidenceAndEndpoints()
    {
        var node = Node("task", "task", "TASK-001", "Task", 'a');
        var nodeId = TraceGraphRepository.ComputeNodeId(node.NodeNamespace, node.CanonicalRef);

        Assert.Throws<ArgumentException>(() => _repository.ApplySnapshot(_database,
            Snapshot("bad-edge", '1', DateTimeOffset.UtcNow, [node],
                [Edge(nodeId, nodeId, "caused", "manifest", "declared", "T1", 'b')])));
        Assert.Throws<ArgumentException>(() => _repository.ApplySnapshot(_database,
            Snapshot("bad-tier", '1', DateTimeOffset.UtcNow, [node with { Origin = "model", TrustTier = "T1" }], [])));
        Assert.Throws<ArgumentException>(() => _repository.ApplySnapshot(_database,
            Snapshot("bad-confidence", '1', DateTimeOffset.UtcNow, [node],
                [Edge(nodeId, nodeId, "depends_on", "model", "declared", "T2", 'b')])));
        Assert.Throws<ArgumentException>(() => _repository.ApplySnapshot(_database,
            Snapshot("bad-endpoint", '1', DateTimeOffset.UtcNow, [node],
                [Edge(nodeId, TraceGraphRepository.ComputeNodeId("task", "missing"), "depends_on", "manifest", "declared", "T1", 'b')])));
        Assert.Throws<ArgumentException>(() => _repository.ApplySnapshot(_database,
            Snapshot("path-leak", '1', DateTimeOffset.UtcNow,
                [Node("file", "file", "C:\\private\\source.cs", "Source", 'a')], [])));
        Assert.Throws<ArgumentException>(() => _repository.ApplySnapshot(_database,
            Snapshot("evidence-path-leak", '1', DateTimeOffset.UtcNow, [node],
                [Edge(nodeId, nodeId, "depends_on", "manifest", "declared", "T1", 'b') with { EvidenceRef = "C:\\private\\evidence.json" }])));
    }

    [Fact]
    public void Rebuild_IsDeterministicAcrossInputAndPropertyOrderAndSupportsCrossSourceEdges()
    {
        var at = DateTimeOffset.Parse("2026-08-28T11:00:00Z");
        var adr = Node("adr", "adr", "ADR-0011", "Graph ADR", 'a') with { PropertiesJson = "{\"z\":2,\"a\":1}" };
        var contract = Node("contract", "contract", "trace.v1", "Trace contract", 'b');
        var adrId = TraceGraphRepository.ComputeNodeId(adr.NodeNamespace, adr.CanonicalRef);
        var contractId = TraceGraphRepository.ComputeNodeId(contract.NodeNamespace, contract.CanonicalRef);
        var reference = Edge(adrId, contractId, "references", "adr", "declared", "T1", 'c') with { PropertiesJson = "{\"b\":2,\"a\":1}" };
        var firstInput = new[]
        {
            Snapshot("decision-source", '1', at, [adr], [reference]),
            Snapshot("contract-source", '2', at, [contract], [])
        };

        var first = _repository.Rebuild(_database, firstInput);
        var secondInput = new[]
        {
            Snapshot("contract-source", '2', at, [contract], []),
            Snapshot("decision-source", '1', at,
                [adr with { PropertiesJson = "{\"a\":1,\"z\":2}" }],
                [reference with { PropertiesJson = "{\"a\":1,\"b\":2}" }])
        };
        var second = _repository.Rebuild(_database, secondInput);

        Assert.Equal(first.Digest, second.Digest);
        Assert.Equal(2, second.Nodes.Count);
        Assert.Single(second.Edges);
    }

    [Fact]
    public void UpdatingOneSourceNamespace_DoesNotInvalidateAnotherSource()
    {
        var at = DateTimeOffset.Parse("2026-08-28T12:00:00Z");
        var left = Node("task", "task", "TASK-A", "Task A", 'a');
        var right = Node("task", "task", "TASK-B", "Task B", 'b');
        _repository.ApplySnapshot(_database, Snapshot("source-a", '1', at, [left], []));
        _repository.ApplySnapshot(_database, Snapshot("source-b", '1', at, [right], []));

        Assert.Throws<InvalidOperationException>(() => _repository.InvalidateSource(_database,
            "source-a", new string('9', 40), new string('2', 40), at.AddMinutes(1)));
        _repository.InvalidateSource(_database, "source-a", new string('1', 40),
            new string('2', 40), at.AddMinutes(1));

        var current = _repository.ReadCurrent(_database);
        Assert.Single(current.Nodes);
        Assert.Equal("TASK-B", current.Nodes[0].CanonicalRef);
        Assert.Equal("source-b", current.Nodes[0].SourceNamespace);
    }

    [Fact]
    public void ApplySnapshot_RejectsNonMonotonicChangesAndDanglingCrossSourceEdges()
    {
        var at = DateTimeOffset.Parse("2026-08-28T13:00:00Z");
        var contract = Node("contract", "contract", "contract-v1", "Contract", 'a');
        var task = Node("task", "task", "TASK-1", "Task", 'b');
        var contractId = TraceGraphRepository.ComputeNodeId(contract.NodeNamespace, contract.CanonicalRef);
        var taskId = TraceGraphRepository.ComputeNodeId(task.NodeNamespace, task.CanonicalRef);
        _repository.ApplySnapshot(_database, Snapshot("contracts", '1', at, [contract], []));

        Assert.Throws<InvalidOperationException>(() => _repository.ApplySnapshot(_database,
            Snapshot("contracts", '2', at.AddMinutes(-1), [contract with { Title = "Changed" }], [])));

        _repository.ApplySnapshot(_database, Snapshot("tasks", '1', at,
            [task], [Edge(taskId, contractId, "implements", "manifest", "declared", "T1", 'c')]));

        Assert.Throws<InvalidOperationException>(() => _repository.ApplySnapshot(_database,
            Snapshot("contracts", '2', at.AddMinutes(1), [], [])));
    }

    private static TraceNodeInput Node(string type, string nodeNamespace, string canonicalRef, string title, char hash)
        => new(type, nodeNamespace, canonicalRef, title, Hash(hash), "manifest", "T1");

    private static TraceEdgeInput Edge(string from, string to, string type, string origin, string confidence, string tier, char hash)
        => new(from, to, type, origin, confidence, tier, "evidence://fixture", Hash(hash));

    private static TraceGraphSnapshot Snapshot(string sourceNamespace, char commit, DateTimeOffset at,
        IReadOnlyList<TraceNodeInput> nodes, IReadOnlyList<TraceEdgeInput> edges)
        => new(sourceNamespace, new string(commit, 40), at, nodes, edges);

    private static string Hash(char value) => new(value, 64);

    public void Dispose()
    {
        SqliteConnection.ClearAllPools();
        try { Directory.Delete(_root, recursive: true); } catch { }
    }
}
