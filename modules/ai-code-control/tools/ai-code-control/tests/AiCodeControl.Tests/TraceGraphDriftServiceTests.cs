using System.Text.Json;
using AiCodeControl.Core.Models;
using AiCodeControl.Core.Services;
using Microsoft.Data.Sqlite;
using Xunit;

namespace AiCodeControl.Tests;

public sealed class TraceGraphDriftServiceTests : IDisposable
{
    private const string Hash = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    private readonly string _root = Path.Combine(Path.GetTempPath(), "ai-code-control-trace-drift-" + Guid.NewGuid().ToString("N"));
    private readonly TraceGraphDriftService _service = new();

    [Fact]
    public void CompleteAuthoritativeGraph_PassesWithDeclaredSourcesWithoutExpectedOrProjection()
    {
        var database = CreateCompleteGraph();

        var report = _service.Check(PassingOptions(database));

        Assert.Equal("PASS", report.Status);
        Assert.Equal("pass", report.Coverage.Status);
        Assert.Equal(100m, report.Coverage.CoveragePercent);
        Assert.Equal("not_applicable", report.ExpectedGraph.Status);
        Assert.Equal("not_applicable", report.Projection.Status);
        Assert.DoesNotContain(report.Findings, finding => finding.Severity == "error");
    }

    [Fact]
    public void EmptyGraph_RequiresReviewInsteadOfReturningFalsePass()
    {
        var database = CreateDatabase();

        var report = _service.Check(Options(database));

        Assert.Equal("REVIEW_REQUIRED", report.Status);
        Assert.Contains(report.Findings, finding => finding.Code == "EMPTY_TRACE_GRAPH");
        Assert.Equal("not_applicable", report.Coverage.Status);
    }

    [Fact]
    public void PopulatedGraphWithoutSourceManifest_CannotClaimReleasePass()
    {
        var database = CreateCompleteGraph();

        var report = _service.Check(Options(database));

        Assert.Equal("REVIEW_REQUIRED", report.Status);
        Assert.Contains(report.Findings, finding => finding.Code == "SOURCE_MANIFEST_NOT_DECLARED");
        Assert.Equal("review", report.Checks.Single(check => check.Name == "canonical_sources").Status);
    }

    [Fact]
    public void CanonicalSourceManifest_EnforcesRequiredOptionalAuthorityAndHash()
    {
        var proposed = Node("adr", "ADR-PROPOSED", authority: "proposed");
        var database = CreateCompleteGraph([proposed]);
        var manifest = WriteJson("sources.json", new
        {
            schemaVersion = "1.0",
            sources = new object[]
            {
                new { nodeType = "criterion", canonicalRef = "AC-1", required = true, sourceHash = new string('b', 64) },
                new { nodeType = "adr", canonicalRef = "ADR-PROPOSED", required = true },
                new { nodeType = "contract", canonicalRef = "OPTIONAL", required = false }
            }
        });

        var report = _service.Check(Options(database) with { SourceManifestPath = manifest });

        Assert.Equal("FAIL", report.Status);
        Assert.Contains(report.Findings, finding => finding.Code == "SOURCE_NOT_AUTHORITATIVE" && finding.Severity == "error");
        Assert.Contains(report.Findings, finding => finding.Code == "SOURCE_OPTIONAL_MISSING" && finding.Severity == "warning");
        Assert.Contains(report.Findings, finding => finding.Code == "SOURCE_HASH_MISMATCH");
    }

    [Fact]
    public void StaleCommitAndMissingIngestRun_FailClosed()
    {
        var staleDatabase = CreateCompleteGraph();
        var stale = _service.Check(Options(staleDatabase) with { ExpectedSourceCommit = "commit-2" });

        var orphanDatabase = CreateCompleteGraph();
        Execute(orphanDatabase, "DELETE FROM trace_ingest_runs;");
        var orphan = _service.Check(Options(orphanDatabase) with { ExpectedSourceCommit = null });

        Assert.Equal("FAIL", stale.Status);
        Assert.Contains(stale.Findings, finding => finding.Code == "SOURCE_COMMIT_STALE");
        Assert.Equal("FAIL", orphan.Status);
        Assert.Contains(orphan.Findings, finding => finding.Code == "NODE_SOURCE_RUN_MISSING");
        Assert.Contains(orphan.Findings, finding => finding.Code == "EDGE_SOURCE_RUN_MISSING");
    }

    [Fact]
    public void CorruptUnknownDanglingEdge_IsDetectedEvenWhenDatabaseConstraintsAreBypassed()
    {
        var database = CreateCompleteGraph();
        Execute(database, $$"""
            PRAGMA ignore_check_constraints=ON;
            INSERT INTO trace_edges(
              edge_id,from_node_id,to_node_id,edge_type,origin,confidence,trust_tier,evidence_ref,
              source_namespace,source_hash,source_commit,valid_from,valid_to,properties_json)
            VALUES(
              'corrupt-edge','missing-from','missing-to','unknown','manifest','declared','T1',
              'corrupt.json','fixture','{{Hash}}','commit-1','2026-08-28T13:00:00Z',NULL,'{}');
            """);

        var report = _service.Check(Options(database));

        Assert.Equal("FAIL", report.Status);
        Assert.Contains(report.Findings, finding => finding.Code == "UNKNOWN_EDGE_TYPE");
        Assert.Contains(report.Findings, finding => finding.Code == "DANGLING_EDGE");
    }

    [Fact]
    public void SupersessionBranchAndCycle_AreAuthoritativeFailures()
    {
        var old = Node("adr", "ADR-1");
        var first = Node("adr", "ADR-2");
        var second = Node("adr", "ADR-3");
        var branchDatabase = CreateCompleteGraph(
            [old, first, second],
            [
                Edge(first, old, "supersedes", "ADR-2.md"),
                Edge(second, old, "supersedes", "ADR-3.md")
            ]);
        var cycleDatabase = CreateCompleteGraph(
            [old, first],
            [
                Edge(first, old, "supersedes", "ADR-2.md"),
                Edge(old, first, "supersedes", "ADR-1.md")
            ]);

        var branch = _service.Check(Options(branchDatabase));
        var cycle = _service.Check(Options(cycleDatabase));

        Assert.Equal("FAIL", branch.Status);
        Assert.Contains(branch.Findings, finding => finding.Code == "SUPERSESSION_BRANCH");
        Assert.Equal("FAIL", cycle.Status);
        Assert.Contains(cycle.Findings, finding => finding.Code == "SUPERSESSION_CYCLE");
    }

    [Fact]
    public void IncompleteCriterionEvidenceChain_FailsCoverageThreshold()
    {
        var task = Node("task", "TASK-INCOMPLETE");
        var criterion = Node("criterion", "AC-INCOMPLETE");
        var database = CreateGraph(
            [task, criterion],
            [Edge(task, criterion, "implements", "plan.json")]);

        var report = _service.Check(Options(database));

        Assert.Equal("FAIL", report.Status);
        Assert.Equal(0m, report.Coverage.CoveragePercent);
        Assert.Contains(report.Findings, finding => finding.Code == "EVIDENCE_CHAIN_INCOMPLETE");
        Assert.Contains(report.Findings, finding => finding.Code == "TRACE_COVERAGE_BELOW_THRESHOLD");
    }

    [Fact]
    public void T2AndAmbiguousCurrentIdentity_RequireReviewButDoNotEnforce()
    {
        var first = Node("rule", "SAME", nodeNamespace: "rule-one");
        var second = Node("rule", "SAME", nodeNamespace: "rule-two");
        var advisory = Node("rule", "MODEL-RULE", origin: "model", tier: "T2", authority: "advisory");
        var database = CreateCompleteGraph([first, second, advisory]);

        var report = _service.Check(Options(database));

        Assert.Equal("REVIEW_REQUIRED", report.Status);
        Assert.Contains(report.Findings, finding => finding.Code == "T2_ADVISORY_PRESENT");
        Assert.Contains(report.Findings, finding => finding.Code == "AMBIGUOUS_CURRENT_IDENTITY");
        Assert.Equal(1, report.Counts.AdvisoryNodes);
    }

    [Fact]
    public void CaseDistinctSymbolIdentities_DoNotRequireReview()
    {
        var type = Node("symbol", "file:app/layout.tsx.Crumbs", nodeNamespace: "symbol-type");
        var value = Node("symbol", "file:app/layout.tsx.crumbs", nodeNamespace: "symbol-value");
        var database = CreateCompleteGraph([type, value]);

        var report = _service.Check(Options(database));

        Assert.DoesNotContain(report.Findings, finding => finding.Code == "AMBIGUOUS_CURRENT_IDENTITY");
    }

    [Fact]
    public void ExpectedGraphSubset_PassesAndReportsDeterministicMissingDiff()
    {
        var database = CreateCompleteGraph();
        var passing = WriteExpected("expected-pass.json", includeMissing: false);
        var failing = WriteExpected("expected-fail.json", includeMissing: true);

        var pass = _service.Check(PassingOptions(database) with { ExpectedGraphPath = passing });
        var fail = _service.Check(Options(database) with { ExpectedGraphPath = failing });

        Assert.Equal("PASS", pass.Status);
        Assert.Equal("pass", pass.ExpectedGraph.Status);
        Assert.Equal("FAIL", fail.Status);
        Assert.Equal(["contract:MISSING"], fail.ExpectedGraph.MissingNodes);
        Assert.Contains(fail.Findings, finding => finding.Code == "EXPECTED_NODE_MISSING");
    }

    [Fact]
    public void ProjectionManifest_PassesExactStateAndFailsDigestCommitOrHashDrift()
    {
        var database = CreateCompleteGraph();
        var state = new TraceGraphRepository().ReadCurrent(database);
        var passing = WriteProjection("projection-pass.json", state.Digest, "commit-1", Hash);
        var failing = WriteProjection("projection-fail.json", new string('b', 64), "old-commit", new string('c', 64));

        var pass = _service.Check(PassingOptions(database) with { ProjectionManifestPath = passing });
        var fail = _service.Check(Options(database) with { ProjectionManifestPath = failing });

        Assert.Equal("PASS", pass.Status);
        Assert.Equal("pass", pass.Projection.Status);
        Assert.Equal("FAIL", fail.Status);
        Assert.Contains(fail.Findings, finding => finding.Code == "PROJECTION_DIGEST_MISMATCH");
        Assert.Contains(fail.Findings, finding => finding.Code == "PROJECTION_COMMIT_STALE");
        Assert.Contains(fail.Findings, finding => finding.Code == "PROJECTION_SOURCE_HASH_MISMATCH");
    }

    [Fact]
    public void DeclaredControlFiles_CannotEscapeScopeOrLeakAbsoluteHostPaths()
    {
        var database = CreateCompleteGraph();
        var outside = Path.Combine(Path.GetTempPath(), "outside-" + Guid.NewGuid().ToString("N") + ".json");
        File.WriteAllText(outside, "{}");
        try
        {
            var report = _service.Check(Options(database) with { SourceManifestPath = outside });
            var json = JsonSerializer.Serialize(report);

            Assert.Equal("FAIL", report.Status);
            Assert.Contains(report.Findings, finding =>
                finding.Code == "SOURCE_MANIFEST_INVALID" && finding.EntityRef == "<outside-scope>");
            Assert.DoesNotContain(_root, json, StringComparison.OrdinalIgnoreCase);
            Assert.DoesNotContain(Path.GetTempPath(), json, StringComparison.OrdinalIgnoreCase);
        }
        finally
        {
            File.Delete(outside);
        }
    }

    [Fact]
    public void VersionOne_RejectsMisleadingSubdirectoryScope()
    {
        var database = CreateCompleteGraph();
        Directory.CreateDirectory(Path.Combine(_root, "subdir"));

        var error = Assert.Throws<ArgumentException>(() =>
            _service.Check(Options(database) with { ScopePath = "subdir" }));

        Assert.Contains("repository-root scope", error.Message, StringComparison.Ordinal);
    }

    private string CreateCompleteGraph(
        IReadOnlyList<TraceNodeInput>? extraNodes = null,
        IReadOnlyList<TraceEdgeInput>? extraEdges = null)
    {
        var task = Node("task", "TASK-1");
        var criterion = Node("criterion", "AC-1");
        var gate = Node("gate", "G-1");
        var evidence = Node("evidence", "evidence.json#G-1", origin: "runtime-evidence", tier: "T0");
        return CreateGraph(
            new[] { task, criterion, gate, evidence }.Concat(extraNodes ?? []).ToList(),
            new[]
            {
                Edge(task, criterion, "implements", "plan.json"),
                Edge(criterion, gate, "verified_by", "plan.json#gate"),
                Edge(gate, evidence, "verified_by", "evidence.json", "runtime-evidence", "deterministic", "T0")
            }.Concat(extraEdges ?? []).ToList());
    }

    private string CreateGraph(IReadOnlyList<TraceNodeInput> nodes, IReadOnlyList<TraceEdgeInput> edges)
    {
        var database = CreateDatabase();
        new TraceGraphRepository().ApplySnapshot(database,
            new TraceGraphSnapshot("fixture", "commit-1", DateTimeOffset.Parse("2026-08-28T12:00:00Z"), nodes, edges));
        return database;
    }

    private string CreateDatabase()
    {
        Directory.CreateDirectory(_root);
        var database = Path.Combine(_root, Guid.NewGuid().ToString("N") + ".sqlite");
        new DatabaseInitializer().InitializeCodegraph(_root, database);
        return database;
    }

    private TraceGraphDriftOptions Options(string database)
        => new(_root, database, ".", "commit-1");

    private TraceGraphDriftOptions PassingOptions(string database)
    {
        var sourceManifest = WriteJson("passing-sources.json", new
        {
            schemaVersion = "1.0",
            sources = new[] { new { nodeType = "criterion", canonicalRef = "AC-1", required = true } }
        });
        return Options(database) with { SourceManifestPath = sourceManifest };
    }

    private string WriteExpected(string fileName, bool includeMissing)
    {
        var nodes = new List<object>
        {
            new { nodeType = "task", canonicalRef = "TASK-1" },
            new { nodeType = "criterion", canonicalRef = "AC-1" },
            new { nodeType = "gate", canonicalRef = "G-1" },
            new { nodeType = "evidence", canonicalRef = "evidence.json#G-1" }
        };
        if (includeMissing) nodes.Add(new { nodeType = "contract", canonicalRef = "MISSING" });
        return WriteJson(fileName, new
        {
            schemaVersion = "1.0",
            mode = "subset",
            nodes,
            edges = new object[]
            {
                new
                {
                    from = new { nodeType = "task", canonicalRef = "TASK-1" },
                    relation = "implements",
                    to = new { nodeType = "criterion", canonicalRef = "AC-1" },
                    evidenceRef = "plan.json",
                    trustTier = "T1"
                }
            }
        });
    }

    private string WriteProjection(string fileName, string digest, string commit, string sourceHash)
        => WriteJson(fileName, new
        {
            schemaVersion = "1.0",
            graphDigest = digest,
            sourceCommit = commit,
            sourceHashes = new[] { new { sourceNamespace = "fixture", sourceHash } }
        });

    private string WriteJson(string fileName, object value)
    {
        var path = Path.Combine(_root, fileName);
        File.WriteAllText(path, JsonSerializer.Serialize(value));
        return fileName;
    }

    private static TraceNodeInput Node(
        string type,
        string canonicalRef,
        string origin = "manifest",
        string tier = "T1",
        string authority = "canonical",
        string? nodeNamespace = null)
        => new(type, nodeNamespace ?? type, canonicalRef, canonicalRef, Hash, origin, tier, "{}", authority);

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

    private static void Execute(string database, string sql)
    {
        using var connection = new SqliteConnection($"Data Source={database}");
        connection.Open();
        using var command = connection.CreateCommand();
        command.CommandText = sql;
        command.ExecuteNonQuery();
    }

    public void Dispose()
    {
        SqliteConnection.ClearAllPools();
        if (Directory.Exists(_root)) Directory.Delete(_root, recursive: true);
    }
}
