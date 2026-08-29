import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { SchemaRegistry } from "../../src/schema/json-schema.js";
import { buildSemanticSourceMap, computeSemanticSourceMapDigest, writeSemanticSourceMap, type SourceMapManifest } from "../../src/source-map/semantic-source-map.js";

const roots: string[] = [];
const registry = SchemaRegistry.load({ schemaDirectory: "schemas" });

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe("semantic source map", () => {
  it("builds a deterministic glass-box chain from declared IDs and observed evidence", () => {
    const root = runRoot();
    const manifest = traceableManifest();
    writeTaskArtifacts(root, true);
    const first = buildSemanticSourceMap({
      runRoot: root,
      manifest,
      manifestSha256: "a".repeat(64),
      taskCommits: { "TASK-01": "b".repeat(40) },
      events: committedEvents(),
      createdAt: "2026-08-28T00:00:00Z",
      registry
    })!;
    const repeated = buildSemanticSourceMap({
      runRoot: root,
      manifest,
      manifestSha256: "a".repeat(64),
      taskCommits: { "TASK-01": "b".repeat(40) },
      events: [...committedEvents()].reverse(),
      createdAt: "2026-08-29T00:00:00Z",
      registry
    })!;

    assert.equal(first.coverage.complete, true);
    assert.equal(first.coverage.traceCoveragePercent, 100);
    assert.equal(first.sourceMapDigest, repeated.sourceMapDigest);
    assert.equal(computeSemanticSourceMapDigest(first), first.sourceMapDigest);
    assert.deepEqual(registry.validate("source-map.schema.json", first), { valid: true, errors: [] });
    assert.equal(first.edges.some((edge) => (edge.relation as string) === "caused"), false);
    const proposed = first.nodes.find((node) => node.authority === "proposed")!;
    assert.equal(
      first.edges.some((edge) => edge.relation === "verified_by" && (edge.fromNodeId === proposed.nodeId || edge.toNodeId === proposed.nodeId)),
      false
    );
    assert.ok(first.edges.some((edge) => edge.relation === "selected_for"));
    assert.ok(first.edges.some((edge) => edge.relation === "requires"));
    assert.ok(first.edges.some((edge) => edge.relation === "implemented_by"));
    assert.ok(first.edges.some((edge) => edge.relation === "changed_by"));
    assert.ok(first.edges.some((edge) => edge.relation === "verified_by"));
    assert.ok(first.edges.some((edge) => edge.relation === "derived_from"));

    const path = writeSemanticSourceMap(root, first);
    assert.equal(JSON.parse(readFileSync(path, "utf8")).sourceMapDigest, first.sourceMapDigest);
  });

  it("fails coverage when a PASS criterion has no passing command evidence", () => {
    const root = runRoot();
    writeTaskArtifacts(root, false);
    const sourceMap = buildSemanticSourceMap({
      runRoot: root,
      manifest: traceableManifest(),
      manifestSha256: "a".repeat(64),
      taskCommits: { "TASK-01": "b".repeat(40) },
      events: committedEvents(),
      registry
    })!;

    assert.equal(sourceMap.coverage.complete, false);
    assert.equal(sourceMap.coverage.criteriaWithDirectEvidence, 0);
    assert.ok(sourceMap.findings.some((finding) => finding.code === "EVIDENCE_NOT_PASSING"));
  });

  it("does not impose source-map enforcement on legacy v1.0 manifests", () => {
    const legacy = { ...traceableManifest(), schemaVersion: "1.0" as const };
    assert.equal(
      buildSemanticSourceMap({ runRoot: runRoot(), manifest: legacy, manifestSha256: "a".repeat(64), taskCommits: {}, events: [] }),
      null
    );
  });
});

function runRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "aicw-source-map-"));
  roots.push(root);
  mkdirSync(join(root, "tasks", "TASK-01"), { recursive: true });
  return root;
}

function traceableManifest(): SourceMapManifest {
  return {
    schemaVersion: "1.1",
    runId: "run-source-map",
    tasks: [{
      id: "TASK-01",
      requiredInputs: ["contracts/api.schema.json"],
      relevantSymbols: ["ApiHandler"],
      traceability: {
        acceptanceCriteria: [{ criterionId: "TASK-01-AC-01", text: "API contract is implemented." }],
        gates: [{
          gateId: "TASK-01-G-01",
          command: "unit",
          evidenceContract: "Command exits zero.",
          criterionIds: ["TASK-01-AC-01"]
        }]
      }
    }]
  };
}

function writeTaskArtifacts(root: string, passing: boolean): void {
  writeFileSync(join(root, "tasks", "TASK-01", "context-package.v1.json"), JSON.stringify({
    schemaVersion: "1.0",
    packageId: "pkg-1",
    runId: "run-source-map",
    taskId: "TASK-01",
    manifestSha256: "a".repeat(64),
    compilerVersion: "1",
    sources: [
      { sourceId: "adr", sourceType: "decision", canonicalRef: "docs/adr/proposal.md", sourceHash: "1".repeat(64), sourceCommit: null, authority: "proposed", selectionReason: "declared" },
      { sourceId: "contract", sourceType: "contract", canonicalRef: "contracts/api.schema.json", sourceHash: "2".repeat(64), sourceCommit: null, authority: "canonical", selectionReason: "declared" }
    ],
    budget: { measurement: "characters-fallback", maximumTokens: 100, estimatedTokens: 10, omittedSources: [] },
    diagnostics: [],
    contextDigest: "3".repeat(64),
    createdAt: "2026-08-28T00:00:00Z"
  }), "utf8");
  writeFileSync(join(root, "tasks", "TASK-01", "evidence.json"), JSON.stringify({
    commands: [{ id: "unit", exitCode: passing ? 0 : 1 }],
    taskTraceability: {
      taskId: "TASK-01",
      criterionIds: ["TASK-01-AC-01"],
      gates: [{ gateId: "TASK-01-G-01", criterionIds: ["TASK-01-AC-01"], commandId: "unit" }]
    }
  }), "utf8");
}

function committedEvents() {
  return [{ type: "task.committed", payload: { taskId: "TASK-01", changedPaths: ["src/api.ts"] } }];
}
