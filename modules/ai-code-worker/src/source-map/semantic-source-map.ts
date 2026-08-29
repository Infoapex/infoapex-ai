import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ContextPackage } from "../context-provider/types.js";
import { canonicalJson, sha256 } from "../manifest/normalize.js";
import type { ManifestTaskTraceability } from "../manifest/traceability.js";
import { SchemaRegistry, type JsonValue } from "../schema/json-schema.js";

type NodeKind = "source" | "decision" | "contract" | "criterion" | "task" | "file" | "symbol" | "gate" | "evidence" | "commit" | "context-package";
type Authority = "canonical" | "advisory" | "proposed" | "generated";
type Relation = "selected_for" | "requires" | "implemented_by" | "changed_by" | "verified_by" | "derived_from";

export interface SourceMapManifestTask {
  readonly id: string;
  readonly requiredInputs: readonly string[];
  readonly relevantSymbols?: readonly string[];
  readonly traceability?: ManifestTaskTraceability;
}

export interface SourceMapManifest {
  readonly schemaVersion: "1.0" | "1.1";
  readonly runId: string;
  readonly tasks: readonly SourceMapManifestTask[];
}

export interface SemanticSourceMap {
  readonly schemaVersion: "1.0";
  readonly runId: string;
  readonly manifestSha256: string;
  readonly nodes: readonly SourceMapNode[];
  readonly edges: readonly SourceMapEdge[];
  readonly coverage: {
    readonly criteriaTotal: number;
    readonly criteriaWithDirectEvidence: number;
    readonly traceCoveragePercent: number;
    readonly complete: boolean;
  };
  readonly findings: readonly SourceMapFinding[];
  readonly sourceMapDigest: string;
  readonly createdAt: string;
}

interface SourceMapNode {
  readonly nodeId: string;
  readonly kind: NodeKind;
  readonly canonicalRef: string;
  readonly authority: Authority;
}

interface SourceMapEdge {
  readonly edgeId: string;
  readonly relation: Relation;
  readonly fromNodeId: string;
  readonly toNodeId: string;
  readonly confidence: "declared" | "observed" | "derived";
  readonly evidenceRefs: readonly string[];
}

interface SourceMapFinding {
  readonly code: "TRACEABILITY_MISSING" | "EVIDENCE_MISSING" | "EVIDENCE_NOT_PASSING" | "ID_BOUNDARY_LOSS" | "PROPOSED_SOURCE_AS_EVIDENCE";
  readonly message: string;
}

interface EvidenceArtifact {
  readonly commands?: readonly { readonly id: string; readonly exitCode: number | null }[];
  readonly taskTraceability?: {
    readonly taskId: string;
    readonly criterionIds: readonly string[];
    readonly gates: readonly {
      readonly gateId: string;
      readonly criterionIds: readonly string[];
      readonly commandId: string | null;
    }[];
  };
}

export function buildSemanticSourceMap(input: {
  readonly runRoot: string;
  readonly manifest: SourceMapManifest;
  readonly manifestSha256: string;
  readonly taskCommits: Readonly<Record<string, string>>;
  readonly events: readonly { readonly type: string; readonly payload: Record<string, unknown> }[];
  readonly createdAt?: string;
  readonly registry?: SchemaRegistry;
}): SemanticSourceMap | null {
  if (input.manifest.schemaVersion !== "1.1") return null;
  const nodes = new Map<string, SourceMapNode>();
  const edges = new Map<string, SourceMapEdge>();
  const findings: SourceMapFinding[] = [];
  const evidencedCriteria = new Set<string>();
  const criterionOwners = new Map<string, string>();
  const gateOwners = new Map<string, string>();
  let criteriaTotal = 0;

  const node = (kind: NodeKind, canonicalRef: string, authority: Authority): SourceMapNode => {
    const key = `${kind}:${canonicalRef}`;
    const value = { nodeId: `node-${sha256(key).slice(0, 16)}`, kind, canonicalRef, authority };
    nodes.set(value.nodeId, value);
    return value;
  };
  const edge = (
    relation: Relation,
    from: SourceMapNode,
    to: SourceMapNode,
    confidence: SourceMapEdge["confidence"],
    evidenceRefs: readonly string[]
  ): void => {
    if (relation === "verified_by" && (from.authority === "proposed" || to.authority === "proposed")) {
      findings.push({ code: "PROPOSED_SOURCE_AS_EVIDENCE", message: `Proposed node cannot verify a verdict: ${from.canonicalRef} -> ${to.canonicalRef}` });
      return;
    }
    const normalizedEvidence = [...new Set(evidenceRefs)].sort();
    const key = `${relation}:${from.nodeId}:${to.nodeId}:${normalizedEvidence.join("|")}`;
    const value = {
      edgeId: `edge-${sha256(key).slice(0, 16)}`,
      relation,
      fromNodeId: from.nodeId,
      toNodeId: to.nodeId,
      confidence,
      evidenceRefs: normalizedEvidence
    };
    edges.set(value.edgeId, value);
  };

  for (const task of [...input.manifest.tasks].sort((a, b) => a.id.localeCompare(b.id))) {
    const taskNode = node("task", `task:${task.id}`, "canonical");
    const contextPackage = readContextPackage(input.runRoot, task.id);
    const sources = contextPackage?.sources ?? task.requiredInputs.map((canonicalRef) => {
      const sourceType = inferSourceType(canonicalRef);
      return {
        sourceId: canonicalRef,
        sourceType,
        canonicalRef,
        sourceHash: "",
        sourceCommit: null,
        authority: (sourceType === "contract" ? "canonical" : "advisory") as Authority,
        selectionReason: "manifest.requiredInputs"
      };
    });

    if (contextPackage) {
      const packageNode = node("context-package", `context-package:${contextPackage.contextDigest}`, "generated");
      for (const source of sources) {
        const sourceNode = node(sourceKind(source.sourceType), source.canonicalRef, source.authority);
        edge("derived_from", packageNode, sourceNode, "observed", [`tasks/${task.id}/context-package.v1.json`]);
      }
    }
    for (const source of sources) {
      const sourceNode = node(sourceKind(source.sourceType), source.canonicalRef, source.authority);
      edge("selected_for", sourceNode, taskNode, "observed", contextPackage ? [`tasks/${task.id}/context-package.v1.json`] : ["manifest.json"]);
      edge("requires", taskNode, sourceNode, "declared", ["manifest.json"]);
    }
    for (const symbol of [...(task.relevantSymbols ?? [])].sort()) {
      const symbolNode = node("symbol", symbol, "canonical");
      edge("requires", taskNode, symbolNode, "declared", ["manifest.json"]);
    }

    const traceability = task.traceability;
    if (!traceability) {
      findings.push({ code: "TRACEABILITY_MISSING", message: `Task ${task.id} has no traceability block.` });
      continue;
    }
    const evidenceRef = `tasks/${task.id}/evidence.json`;
    const evidence = readEvidence(input.runRoot, task.id);
    if (!evidence) findings.push({ code: "EVIDENCE_MISSING", message: `Task ${task.id} has no readable evidence artifact.` });
    if (evidence?.taskTraceability?.taskId !== task.id) {
      findings.push({ code: "ID_BOUNDARY_LOSS", message: `Evidence task ID does not round-trip for ${task.id}.` });
    }
    const commandById = new Map((evidence?.commands ?? []).map((command) => [command.id, command]));
    const evidenceGateById = new Map((evidence?.taskTraceability?.gates ?? []).map((gate) => [gate.gateId, gate]));
    const manifestCriterionIds = new Set(traceability.acceptanceCriteria.map((criterion) => criterion.criterionId));
    const evidenceCriterionIds = new Set(evidence?.taskTraceability?.criterionIds ?? []);

    for (const criterion of traceability.acceptanceCriteria) {
      criteriaTotal += 1;
      const existingCriterionOwner = criterionOwners.get(criterion.criterionId);
      if (existingCriterionOwner && existingCriterionOwner !== task.id) {
        findings.push({ code: "ID_BOUNDARY_LOSS", message: `Criterion ID ${criterion.criterionId} is reused by ${existingCriterionOwner} and ${task.id}.` });
      } else {
        criterionOwners.set(criterion.criterionId, task.id);
      }
      const criterionNode = node("criterion", `criterion:${criterion.criterionId}`, "canonical");
      edge("implemented_by", criterionNode, taskNode, "declared", ["manifest.json"]);
      if (!evidenceCriterionIds.has(criterion.criterionId)) {
        findings.push({ code: "ID_BOUNDARY_LOSS", message: `Criterion ID ${criterion.criterionId} is missing from ${evidenceRef}.` });
      }
      for (const source of sources) {
        edge("selected_for", node(sourceKind(source.sourceType), source.canonicalRef, source.authority), criterionNode, "derived", ["manifest.json"]);
      }
    }

    for (const gate of traceability.gates) {
      const existingGateOwner = gateOwners.get(gate.gateId);
      if (existingGateOwner && existingGateOwner !== task.id) {
        findings.push({ code: "ID_BOUNDARY_LOSS", message: `Gate ID ${gate.gateId} is reused by ${existingGateOwner} and ${task.id}.` });
      } else {
        gateOwners.set(gate.gateId, task.id);
      }
      const gateNode = node("gate", `gate:${gate.gateId}`, "canonical");
      const evidenceGate = evidenceGateById.get(gate.gateId);
      if (!evidenceGate || !sameIds(gate.criterionIds, evidenceGate.criterionIds)) {
        findings.push({ code: "ID_BOUNDARY_LOSS", message: `Gate ID or criterion links did not round-trip for ${gate.gateId}.` });
      }
      const command = evidenceGate?.commandId ? commandById.get(evidenceGate.commandId) : undefined;
      const evidenceNode = node("evidence", `${evidenceRef}#gate:${gate.gateId}`, "generated");
      edge("verified_by", gateNode, evidenceNode, "observed", [evidenceRef]);
      for (const criterionId of gate.criterionIds) {
        if (!manifestCriterionIds.has(criterionId)) {
          findings.push({ code: "ID_BOUNDARY_LOSS", message: `Gate ${gate.gateId} references unknown criterion ${criterionId}.` });
          continue;
        }
        const criterionNode = node("criterion", `criterion:${criterionId}`, "canonical");
        edge("verified_by", criterionNode, gateNode, "declared", ["manifest.json", evidenceRef]);
        if (command?.exitCode === 0) evidencedCriteria.add(`${task.id}:${criterionId}`);
      }
      if (!command) findings.push({ code: "EVIDENCE_MISSING", message: `Gate ${gate.gateId} has no linked command evidence.` });
      else if (command.exitCode !== 0) findings.push({ code: "EVIDENCE_NOT_PASSING", message: `Gate ${gate.gateId} evidence is not passing.` });
    }

    const commit = input.taskCommits[task.id];
    if (commit) {
      const commitNode = node("commit", `git:${commit}`, "generated");
      for (const changedPath of changedPathsFor(input.events, task.id)) {
        const fileNode = node("file", changedPath, "canonical");
        edge("implemented_by", taskNode, fileNode, "observed", ["events.jsonl"]);
        edge("changed_by", fileNode, commitNode, "observed", ["events.jsonl"]);
      }
    }
  }

  const criteriaWithDirectEvidence = evidencedCriteria.size;
  const coverage = {
    criteriaTotal,
    criteriaWithDirectEvidence,
    traceCoveragePercent: criteriaTotal === 0 ? 100 : (criteriaWithDirectEvidence / criteriaTotal) * 100,
    complete: findings.length === 0 && criteriaWithDirectEvidence === criteriaTotal
  };
  const semantic = {
    schemaVersion: "1.0" as const,
    runId: input.manifest.runId,
    manifestSha256: input.manifestSha256,
    nodes: [...nodes.values()].sort(compareNode),
    edges: [...edges.values()].sort(compareEdge),
    coverage,
    findings: dedupeFindings(findings)
  };
  const sourceMap: SemanticSourceMap = {
    ...semantic,
    sourceMapDigest: sha256(canonicalJson(semantic as unknown as JsonValue)),
    createdAt: input.createdAt ?? new Date().toISOString()
  };
  (input.registry ?? SchemaRegistry.load()).assertValid("source-map.schema.json", sourceMap);
  return sourceMap;
}

export function writeSemanticSourceMap(runRoot: string, sourceMap: SemanticSourceMap): string {
  if (computeSemanticSourceMapDigest(sourceMap) !== sourceMap.sourceMapDigest) {
    throw new Error("Semantic source-map digest mismatch; refusing to persist the artifact.");
  }
  const path = join(runRoot, "source-map.v1.json");
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(sourceMap, null, 2)}\n`, "utf8");
  return path;
}

export function computeSemanticSourceMapDigest(sourceMap: SemanticSourceMap): string {
  const { sourceMapDigest: _digest, createdAt: _createdAt, ...semantic } = sourceMap;
  return sha256(canonicalJson(semantic as unknown as JsonValue));
}

function readContextPackage(runRoot: string, taskId: string): ContextPackage | null {
  return readJson<ContextPackage>(join(runRoot, "tasks", taskId, "context-package.v1.json"));
}

function readEvidence(runRoot: string, taskId: string): EvidenceArtifact | null {
  return readJson<EvidenceArtifact>(join(runRoot, "tasks", taskId, "evidence.json"));
}

function readJson<T>(path: string): T | null {
  if (!existsSync(path)) return null;
  try { return JSON.parse(readFileSync(path, "utf8")) as T; } catch { return null; }
}

function changedPathsFor(events: readonly { readonly type: string; readonly payload: Record<string, unknown> }[], taskId: string): readonly string[] {
  return [...new Set(events.flatMap((event) =>
    event.type === "task.committed" && event.payload.taskId === taskId && Array.isArray(event.payload.changedPaths)
      ? event.payload.changedPaths.filter((item): item is string => typeof item === "string")
      : []
  ))].sort();
}

function sourceKind(sourceType: string): NodeKind {
  if (sourceType === "contract") return "contract";
  if (sourceType === "decision") return "decision";
  if (sourceType === "symbol") return "symbol";
  return "source";
}

function inferSourceType(canonicalRef: string): ContextPackage["sources"][number]["sourceType"] {
  const value = canonicalRef.toLowerCase();
  if (value.startsWith("contracts/") || value.includes("/contracts/") || value.endsWith(".schema.json")) return "contract";
  if (value.includes("/adr/") || value.includes("/decisions/")) return "decision";
  return "file";
}

function sameIds(left: readonly string[], right: readonly string[]): boolean {
  return [...left].sort().join("\n") === [...right].sort().join("\n");
}

function compareNode(left: SourceMapNode, right: SourceMapNode): number {
  return left.kind.localeCompare(right.kind) || left.canonicalRef.localeCompare(right.canonicalRef);
}

function compareEdge(left: SourceMapEdge, right: SourceMapEdge): number {
  return left.relation.localeCompare(right.relation) || left.fromNodeId.localeCompare(right.fromNodeId) || left.toNodeId.localeCompare(right.toNodeId);
}

function dedupeFindings(findings: readonly SourceMapFinding[]): readonly SourceMapFinding[] {
  return [...new Map(findings.map((finding) => [`${finding.code}:${finding.message}`, finding])).values()]
    .sort((left, right) => left.code.localeCompare(right.code) || left.message.localeCompare(right.message));
}
