using System.Diagnostics;
using System.Text.Json;
using AiCodeControl.Core.Models;
using AiCodeControl.Core.Services;
using Microsoft.Data.Sqlite;
using Xunit;
using Xunit.Abstractions;

namespace AiCodeControl.Tests;

public sealed class TraceGraphQueryServiceTests : IDisposable
{
    private const string Hash = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    private readonly string _root = Path.Combine(Path.GetTempPath(), "ai-code-control-trace-query-" + Guid.NewGuid().ToString("N"));
    private readonly TraceGraphQueryService _service = new();
    private readonly ITestOutputHelper _output;

    public TraceGraphQueryServiceTests(ITestOutputHelper output)
    {
        _output = output;
    }

    [Fact]
    public void Trace_IsBoundedDetectsCyclesAndIncludesEvidenceProvenance()
    {
        var task = Node("task", "TASK-1");
        var criterion = Node("criterion", "AC-1");
        var gate = Node("gate", "G-1");
        var database = Create(
            [task, criterion, gate],
            [
                Edge(task, criterion, "implements", "plan.json"),
                Edge(criterion, gate, "verified_by", "plan.json#gate"),
                Edge(gate, task, "depends_on", "relations.json#cycle")
            ]);

        var result = _service.Query(database, "trace", "TASK-1",
            new TraceGraphQueryOptions(5, 10, 10, false, "commit-1"));

        Assert.Equal("ok", result.Status);
        Assert.Equal("trace_graph", result.Route);
        Assert.False(result.FallbackUsed);
        Assert.Equal(3, result.Nodes.Count);
        Assert.Equal(3, result.Edges.Count);
        Assert.True(result.Metrics.CyclesDetected >= 1);
        Assert.True(result.EvidenceComplete);
        Assert.All(result.Edges, edge => Assert.False(string.IsNullOrWhiteSpace(edge.EvidenceRef)));
        Assert.All(result.Paths, path => Assert.Equal(path.EdgeIds.Count, path.EvidenceRefs.Count));
        Assert.Equal("fresh", result.Freshness.Status);
    }

    [Fact]
    public void Trace_ExcludesT2ByDefaultAndMarksOptInResultAdvisory()
    {
        var task = Node("task", "TASK-1");
        var inferred = Node("rule", "RULE-T2", origin: "model", tier: "T2", authority: "advisory");
        var database = Create(
            [task, inferred],
            [Edge(task, inferred, "references", "model-output.json", "model", "inferred", "T2")]);

        var normal = _service.Query(database, "trace", "TASK-1",
            new TraceGraphQueryOptions(3, 10, 10, false, "commit-1"));
        var advisory = _service.Query(database, "trace", "TASK-1",
            new TraceGraphQueryOptions(3, 10, 10, true, "commit-1"));

        Assert.Single(normal.Nodes);
        Assert.Empty(normal.Edges);
        Assert.True(normal.Authoritative);
        Assert.True(normal.Metrics.AdvisoryItemsOmitted >= 2);
        Assert.Equal(2, advisory.Nodes.Count);
        Assert.True(advisory.Advisory);
        Assert.False(advisory.Authoritative);
    }

    [Fact]
    public void Why_RejectsAmbiguousSimpleSymbolAndAcceptsExactCanonicalRef()
    {
        var first = Node("symbol", "Namespace.One.Run");
        var second = Node("symbol", "Namespace.Two.Run");
        var database = Create([first, second], []);

        var ambiguous = _service.Query(database, "why", "Run", Expected());
        var exact = _service.Query(database, "why", "Namespace.One.Run", Expected());

        Assert.Equal("ambiguous", ambiguous.Status);
        Assert.Equal(2, ambiguous.Candidates.Count);
        Assert.Equal("ok", exact.Status);
        Assert.Equal(first.CanonicalRef, exact.Root!.CanonicalRef);
    }

    [Fact]
    public void Query_ReturnsNotFoundWithoutFallbackAndUnsupportedForWrongRoute()
    {
        var criterion = Node("criterion", "AC-1");
        var database = Create([criterion], []);

        var missing = _service.Query(database, "trace", "missing", Expected());
        var unsupported = _service.Query(database, "why", "AC-1", Expected());

        Assert.Equal("not_found", missing.Status);
        Assert.False(missing.FallbackUsed);
        Assert.Contains(missing.Diagnostics, item => item.Contains("No fallback", StringComparison.Ordinal));
        Assert.Equal("unsupported", unsupported.Status);
        Assert.Equal("criterion", unsupported.Root!.NodeType);
    }

    [Fact]
    public void Query_ReturnsStaleWhenLatestIngestCommitDoesNotMatchPrecondition()
    {
        var database = Create([Node("adr", "ADR-1")], []);

        var result = _service.Query(database, "current", "ADR-1",
            new TraceGraphQueryOptions(3, 10, 10, false, "newer-commit"));

        Assert.Equal("stale", result.Status);
        Assert.Equal("stale", result.Freshness.Status);
        Assert.Equal(["fixture"], result.Freshness.StaleSources);
    }

    [Fact]
    public void Trace_NeverExceedsDepthNodeOrEdgeBudgets()
    {
        var one = Node("task", "T-1");
        var two = Node("criterion", "C-2");
        var three = Node("gate", "G-3");
        var four = Node("evidence", "E-4", origin: "runtime-evidence", tier: "T0");
        var database = Create(
            [one, two, three, four],
            [
                Edge(one, two, "implements", "plan.json"),
                Edge(two, three, "verified_by", "plan.json"),
                Edge(three, four, "verified_by", "evidence.json", "runtime-evidence", "deterministic", "T0")
            ]);

        var result = _service.Query(database, "trace", "T-1",
            new TraceGraphQueryOptions(1, 2, 1, false, "commit-1"));

        Assert.Equal("partial", result.Status);
        Assert.True(result.Metrics.Partial);
        Assert.True(result.Nodes.Count <= 2);
        Assert.True(result.Edges.Count <= 1);
        Assert.All(result.Nodes, node => Assert.True(node.Depth <= 1));
        Assert.NotEmpty(result.Metrics.TruncationReasons);
    }

    [Fact]
    public void Current_FollowsSupersessionAndReportsBranchingAsAmbiguous()
    {
        var old = Node("adr", "ADR-1");
        var current = Node("adr", "ADR-2");
        var other = Node("adr", "ADR-3");
        var linearDatabase = Create(
            [old, current],
            [Edge(current, old, "supersedes", "ADR-2.md")]);
        var branchingDatabase = Create(
            [old, current, other],
            [
                Edge(current, old, "supersedes", "ADR-2.md"),
                Edge(other, old, "supersedes", "ADR-3.md")
            ]);

        var linear = _service.Query(linearDatabase, "current", "ADR-1", Expected());
        var branching = _service.Query(branchingDatabase, "current", "ADR-1", Expected());

        Assert.Equal("ok", linear.Status);
        Assert.Equal("ADR-2", Assert.Single(linear.CurrentEntities).CanonicalRef);
        Assert.Equal("ambiguous", branching.Status);
        Assert.Equal(2, branching.CurrentEntities.Count);
    }

    [Fact]
    public void EvidenceFor_UsesOnlyImplementsThenVerifiedByPaths()
    {
        var task = Node("task", "TASK-1");
        var criterion = Node("criterion", "AC-1");
        var gate = Node("gate", "G-1");
        var evidence = Node("evidence", "evidence.json#G-1", origin: "runtime-evidence", tier: "T0");
        var contract = Node("contract", "contract.json", origin: "json-contract", tier: "T0");
        var database = Create(
            [task, criterion, gate, evidence, contract],
            [
                Edge(task, criterion, "implements", "plan.json"),
                Edge(criterion, gate, "verified_by", "plan.json#gate"),
                Edge(gate, evidence, "verified_by", "evidence.json", "runtime-evidence", "deterministic", "T0"),
                Edge(criterion, contract, "references", "plan.json")
            ]);

        var result = _service.Query(database, "evidence-for", "TASK-1",
            new TraceGraphQueryOptions(4, 20, 20, false, "commit-1"));

        Assert.Equal("ok", result.Status);
        Assert.Contains(result.Nodes, item => item.NodeType == "evidence");
        Assert.DoesNotContain(result.Nodes, item => item.NodeType == "contract");
        Assert.Equal(["implements", "verified_by", "verified_by"], result.Edges.Select(item => item.EdgeType));
        Assert.All(result.Paths, path => Assert.True(path.Authoritative));
    }

    [Fact]
    public void Affected_TraversesContractImplementationsWithCompleteProvenance()
    {
        var contract = Node("contract", "contract.json", origin: "json-contract", tier: "T0");
        var file = Node("file", "src/Service.cs", origin: "ast", tier: "T0");
        var task = Node("task", "TASK-1");
        var database = Create(
            [contract, file, task],
            [
                Edge(file, contract, "implements", "source-map.json", "manifest", "declared", "T1"),
                Edge(task, contract, "depends_on", "plan.json")
            ]);

        var result = _service.Query(database, "affected", "contract.json", Expected());

        Assert.Equal("ok", result.Status);
        Assert.Contains(result.Nodes, item => item.NodeType == "file");
        Assert.Contains(result.Nodes, item => item.NodeType == "task");
        Assert.True(result.Authoritative);
        Assert.True(result.EvidenceComplete);
        Assert.All(result.Nodes, item => Assert.False(string.IsNullOrWhiteSpace(item.SourceHash)));
    }

    [Fact]
    public void Query_RejectsLimitsOutsideHardSafetyCaps()
    {
        var database = Create([Node("task", "TASK-1")], []);

        Assert.Throws<ArgumentOutOfRangeException>(() =>
            _service.Query(database, "trace", "TASK-1", new TraceGraphQueryOptions(11, 10, 10)));
        Assert.Throws<ArgumentOutOfRangeException>(() =>
            _service.Query(database, "trace", "TASK-1", new TraceGraphQueryOptions(1, 201, 10)));
        Assert.Throws<ArgumentOutOfRangeException>(() =>
            _service.Query(database, "trace", "TASK-1", new TraceGraphQueryOptions(1, 10, 501)));
    }

    [Fact]
    public void PreregisteredTraceQuestions_ResolveExpectedEntitiesAndEvidencePaths()
    {
        var adrOwner = Node("adr", "ADR-0010");
        var oldAdr = Node("adr", "ADR-0009");
        var contract = Node("contract", "context-package.v1", origin: "json-contract", tier: "T0");
        var criterion = Node("criterion", "SEMANTIC-INVALIDATION");
        var pilotTask = Node("task", "ICM-06");
        var selectionTask = Node("task", "TASK-SELECTION");
        var gate = Node("gate", "INVALIDATION-GATE");
        var evidence = Node("evidence", "icm-06/evidence.json", origin: "runtime-evidence", tier: "T0");
        var package = Node("context-package", "package-digest");
        var database = Create(
            [adrOwner, oldAdr, contract, criterion, pilotTask, selectionTask, gate, evidence, package],
            [
                Edge(adrOwner, contract, "references", "ADR-0010.md"),
                Edge(adrOwner, oldAdr, "supersedes", "ADR-0010.md#supersedes"),
                Edge(pilotTask, criterion, "implements", "ICM-06-plan.json"),
                Edge(criterion, gate, "verified_by", "source-map.json"),
                Edge(gate, evidence, "verified_by", "icm-06/evidence.json", "runtime-evidence", "deterministic", "T0"),
                Edge(package, contract, "derived_from", "context-package.json"),
                Edge(contract, selectionTask, "selected_for", "context-package.json#selection")
            ]);

        var ownership = _service.Query(database, "trace", "ADR-0010", Expected());
        var invalidation = _service.Query(database, "evidence-for", "SEMANTIC-INVALIDATION", Expected());
        var verdict = _service.Query(database, "evidence-for", "ICM-06",
            new TraceGraphQueryOptions(4, 50, 100, false, "commit-1"));
        var current = _service.Query(database, "current", "ADR-0009", Expected());
        var selection = _service.Query(database, "trace", "package-digest", Expected());

        Assert.Contains(ownership.Edges, edge => edge.EdgeType == "references" && edge.EvidenceRef == "ADR-0010.md");
        Assert.Contains(invalidation.Nodes, node => node.NodeType == "evidence");
        Assert.Contains(verdict.Nodes, node => node.CanonicalRef == "icm-06/evidence.json");
        Assert.Equal("ADR-0010", Assert.Single(current.CurrentEntities).CanonicalRef);
        Assert.Contains(selection.Edges, edge => edge.EdgeType == "selected_for");
        Assert.All(new[] { ownership, invalidation, verdict, current, selection }, result =>
        {
            Assert.True(result.EvidenceComplete);
            Assert.True(result.Authoritative);
            Assert.NotEqual("not_found", result.Status);
        });
    }

    [Fact]
    public void LocalQueryP95_RemainsBelowPreregistered250MillisecondBudget()
    {
        var nodes = Enumerable.Range(1, 60).Select(index => Node("task", $"TASK-{index:00}")).ToList();
        var edges = Enumerable.Range(0, nodes.Count - 1)
            .Select(index => Edge(nodes[index], nodes[index + 1], "depends_on", $"plan.json#{index + 1}"))
            .ToList();
        var database = Create(nodes, edges);
        _ = _service.Query(database, "trace", "TASK-01", Expected());

        var samples = new List<double>();
        for (var index = 0; index < 100; index++)
        {
            var stopwatch = Stopwatch.StartNew();
            var result = _service.Query(database, "trace", "TASK-01", Expected());
            stopwatch.Stop();
            Assert.True(result.Nodes.Count <= 50);
            Assert.True(result.Edges.Count <= 100);
            samples.Add(stopwatch.Elapsed.TotalMilliseconds);
        }

        samples.Sort();
        var p95 = samples[(int)Math.Ceiling(samples.Count * 0.95) - 1];
        _output.WriteLine($"trace-query local p95 over 100 warm samples: {p95:F3} ms");
        Assert.True(p95 < 250, $"Expected local trace query p95 below 250 ms, actual {p95:F3} ms.");
    }

    [Fact]
    public void QueryResult_SerializesAsValidCamelCaseMcpJson()
    {
        var database = Create([Node("adr", "ADR-1")], []);
        var result = _service.Query(database, "current", "ADR-1", Expected());

        var json = JsonSerializer.Serialize(result);
        using var document = JsonDocument.Parse(json);

        Assert.Equal("trace_graph", document.RootElement.GetProperty("route").GetString());
        Assert.Equal("current", document.RootElement.GetProperty("kind").GetString());
        Assert.Equal("ok", document.RootElement.GetProperty("status").GetString());
        Assert.False(document.RootElement.GetProperty("fallbackUsed").GetBoolean());
        Assert.Equal(JsonValueKind.Array, document.RootElement.GetProperty("nodes").ValueKind);
        Assert.Equal(JsonValueKind.Array, document.RootElement.GetProperty("paths").ValueKind);
        Assert.Equal(JsonValueKind.Object, document.RootElement.GetProperty("freshness").ValueKind);
        Assert.Equal(JsonValueKind.Object, document.RootElement.GetProperty("metrics").ValueKind);
    }

    private string Create(IReadOnlyList<TraceNodeInput> nodes, IReadOnlyList<TraceEdgeInput> edges)
    {
        Directory.CreateDirectory(_root);
        var database = Path.Combine(_root, Guid.NewGuid().ToString("N") + ".sqlite");
        new DatabaseInitializer().InitializeCodegraph(_root, database);
        new TraceGraphRepository().ApplySnapshot(database,
            new TraceGraphSnapshot("fixture", "commit-1", DateTimeOffset.Parse("2026-08-28T12:00:00Z"), nodes, edges));
        return database;
    }

    private static TraceGraphQueryOptions Expected()
        => new(3, 50, 100, false, "commit-1");

    private static TraceNodeInput Node(
        string type,
        string canonicalRef,
        string origin = "manifest",
        string tier = "T1",
        string authority = "canonical")
        => new(type, type, canonicalRef, canonicalRef, Hash, origin, tier, "{}", authority);

    private static TraceEdgeInput Edge(
        TraceNodeInput from,
        TraceNodeInput to,
        string type,
        string evidence,
        string origin = "manifest",
        string confidence = "declared",
        string tier = "T1")
        => new(
            TraceGraphRepository.ComputeNodeId(from.NodeNamespace, from.CanonicalRef),
            TraceGraphRepository.ComputeNodeId(to.NodeNamespace, to.CanonicalRef),
            type, origin, confidence, tier, evidence, Hash);

    public void Dispose()
    {
        SqliteConnection.ClearAllPools();
        if (Directory.Exists(_root))
            Directory.Delete(_root, recursive: true);
    }
}
