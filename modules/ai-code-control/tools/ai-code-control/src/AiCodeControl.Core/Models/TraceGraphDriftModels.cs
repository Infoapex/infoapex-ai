using System.Text.Json.Serialization;

namespace AiCodeControl.Core.Models;

public sealed record TraceGraphDriftOptions(
    string RepositoryRoot,
    string DatabasePath,
    string ScopePath = ".",
    string? ExpectedSourceCommit = null,
    string? SourceManifestPath = null,
    string? ExpectedGraphPath = null,
    string? ProjectionManifestPath = null,
    decimal MinimumCoveragePercent = 100m);

public sealed record TraceGraphDriftReport(
    [property: JsonPropertyName("schemaVersion")] string SchemaVersion,
    [property: JsonPropertyName("status")] string Status,
    [property: JsonPropertyName("scope")] string Scope,
    [property: JsonPropertyName("expectedSourceCommit")] string? ExpectedSourceCommit,
    [property: JsonPropertyName("graphDigest")] string GraphDigest,
    [property: JsonPropertyName("counts")] TraceGraphDriftCounts Counts,
    [property: JsonPropertyName("coverage")] TraceGraphCoverage Coverage,
    [property: JsonPropertyName("checks")] IReadOnlyList<TraceGraphDriftCheck> Checks,
    [property: JsonPropertyName("findings")] IReadOnlyList<TraceGraphDriftFinding> Findings,
    [property: JsonPropertyName("expectedGraph")] TraceGraphExpectedDiff ExpectedGraph,
    [property: JsonPropertyName("projection")] TraceGraphProjectionCheck Projection);

public sealed record TraceGraphDriftCounts(
    [property: JsonPropertyName("currentNodes")] int CurrentNodes,
    [property: JsonPropertyName("currentEdges")] int CurrentEdges,
    [property: JsonPropertyName("authoritativeNodes")] int AuthoritativeNodes,
    [property: JsonPropertyName("authoritativeEdges")] int AuthoritativeEdges,
    [property: JsonPropertyName("advisoryNodes")] int AdvisoryNodes,
    [property: JsonPropertyName("advisoryEdges")] int AdvisoryEdges);

public sealed record TraceGraphCoverage(
    [property: JsonPropertyName("status")] string Status,
    [property: JsonPropertyName("minimumPercent")] decimal MinimumPercent,
    [property: JsonPropertyName("criteriaTotal")] int CriteriaTotal,
    [property: JsonPropertyName("criteriaComplete")] int CriteriaComplete,
    [property: JsonPropertyName("coveragePercent")] decimal? CoveragePercent,
    [property: JsonPropertyName("incompleteCriteria")] IReadOnlyList<string> IncompleteCriteria);

public sealed record TraceGraphDriftCheck(
    [property: JsonPropertyName("name")] string Name,
    [property: JsonPropertyName("status")] string Status,
    [property: JsonPropertyName("findingCount")] int FindingCount,
    [property: JsonPropertyName("note")] string? Note = null);

public sealed record TraceGraphDriftFinding(
    [property: JsonPropertyName("code")] string Code,
    [property: JsonPropertyName("severity")] string Severity,
    [property: JsonPropertyName("message")] string Message,
    [property: JsonPropertyName("entityRef")] string? EntityRef = null,
    [property: JsonPropertyName("evidenceRefs")] IReadOnlyList<string>? EvidenceRefs = null);

public sealed record TraceGraphExpectedDiff(
    [property: JsonPropertyName("status")] string Status,
    [property: JsonPropertyName("mode")] string? Mode,
    [property: JsonPropertyName("missingNodes")] IReadOnlyList<string> MissingNodes,
    [property: JsonPropertyName("unexpectedNodes")] IReadOnlyList<string> UnexpectedNodes,
    [property: JsonPropertyName("missingEdges")] IReadOnlyList<string> MissingEdges,
    [property: JsonPropertyName("unexpectedEdges")] IReadOnlyList<string> UnexpectedEdges);

public sealed record TraceGraphProjectionCheck(
    [property: JsonPropertyName("status")] string Status,
    [property: JsonPropertyName("manifestPath")] string? ManifestPath,
    [property: JsonPropertyName("expectedDigest")] string? ExpectedDigest,
    [property: JsonPropertyName("actualDigest")] string ActualDigest,
    [property: JsonPropertyName("note")] string? Note = null);
