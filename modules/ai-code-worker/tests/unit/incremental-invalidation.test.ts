import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { invalidationReasons, planIncrementalExecution } from "../../src/snapshots/incremental-invalidation.js";
import { detectRunSemanticDrift } from "../../src/snapshots/detect-run-semantic-drift.js";
import { buildTaskInputSnapshot, type SnapshotManifest, type TaskInputSnapshot } from "../../src/snapshots/task-input-snapshot.js";
import { emptySemanticTaskInputs, type SemanticTaskInputs } from "../../src/snapshots/semantic-task-inputs.js";
import type { TaskRuntimeState } from "../../src/graph/task-graph.js";

const tempRoots: string[] = [];
afterEach(() => {
  while (tempRoots.length > 0) rmSync(tempRoots.pop()!, { recursive: true, force: true });
});

describe("incremental semantic invalidation", () => {
  it("ignores run metadata and source ordering when semantic content is unchanged", () => {
    const previous = snapshot("A", semantic({ contractHashes: [hash("contracts/a", "1"), hash("contracts/b", "2")] }), "run-old");
    const current = snapshot("A", semantic({ contractHashes: [hash("contracts/b", "2"), hash("contracts/a", "1")] }), "run-new");

    assert.deepEqual(invalidationReasons(previous, current), []);
  });

  it("reports compiler upgrades explicitly and separately from digest drift", () => {
    const previous = snapshot("A", semantic({ contextCompilerVersion: "1", contextDigest: "1".repeat(64) }));
    const current = snapshot("A", semantic({ contextCompilerVersion: "2", contextDigest: "2".repeat(64) }));

    assert.deepEqual(invalidationReasons(previous, current), [
      "CONTEXT_COMPILER_VERSION_CHANGED",
      "CONTEXT_DIGEST_CHANGED"
    ]);
  });

  it("reexecutes only the direct semantic consumer and defers descendants until its commit changes", () => {
    const tasks = [
      { id: "A", dependsOn: [] },
      { id: "B", dependsOn: ["A"] },
      { id: "C", dependsOn: [] }
    ];
    const previous = new Map<string, TaskInputSnapshot>([
      ["A", snapshot("A", semantic({ contextDigest: "1".repeat(64) }))],
      ["B", snapshot("B", semantic(), "run-old", passed([["A", "a".repeat(40)]]), tasks)],
      ["C", snapshot("C", semantic())]
    ]);
    const current = new Map<string, TaskInputSnapshot>([
      ["A", snapshot("A", semantic({ contextDigest: "2".repeat(64) }))],
      ["B", snapshot("B", semantic(), "run-new", passed([["A", "a".repeat(40)]]), tasks)],
      ["C", snapshot("C", semantic())]
    ]);
    const plan = planIncrementalExecution({ tasks, previousSnapshots: previous, currentSnapshots: current });

    assert.deepEqual(plan.directInvalidations, [
      { taskId: "A", reasons: ["CONTEXT_DIGEST_CHANGED"], propagation: "direct" }
    ]);
    assert.deepEqual(plan.pendingDescendantTaskIds, ["B"]);
    assert.deepEqual(plan.reusableTaskIds, ["B", "C"]);
  });

  it("classifies contract, gate, policy, toolchain, and dependency changes", () => {
    const tasks = [{ id: "A", dependsOn: [] }, { id: "B", dependsOn: ["A"] }];
    const previous = snapshot("B", semantic(), "run-old", passed([["A", "a".repeat(40)]]), tasks);
    const current = snapshot(
      "B",
      semantic({
        contractHashes: [hash("contracts/a", "3")],
        qualityGateConfigHash: "4".repeat(64),
        policyHash: "5".repeat(64),
        toolchainConfigHash: "6".repeat(64)
      }),
      "run-new",
      passed([["A", "b".repeat(40)]]),
      tasks
    );

    assert.deepEqual(invalidationReasons(previous, current), [
      "DEPENDENCY_INPUT_CHANGED",
      "CONTRACT_HASHES_CHANGED",
      "QUALITY_GATE_CONFIG_CHANGED",
      "POLICY_CHANGED",
      "TOOLCHAIN_CONFIG_CHANGED"
    ]);
  });

  it("detects stored run drift without mutating the frozen run", () => {
    const root = mkdtempSync(join(tmpdir(), "aicw-run-drift-"));
    tempRoots.push(root);
    const taskRoot = join(root, "tasks", "A");
    mkdirSync(taskRoot, { recursive: true });
    const previousSemantic = semantic({ contextDigest: "1".repeat(64) });
    writeFileSync(join(taskRoot, "task-input.json"), JSON.stringify(snapshot("A", previousSemantic)), "utf8");

    assert.deepEqual(detectRunSemanticDrift(root, { A: previousSemantic }), []);
    assert.deepEqual(detectRunSemanticDrift(root, { A: semantic({ contextDigest: "2".repeat(64) }) }), [
      { taskId: "A", reasons: ["CONTEXT_DIGEST_CHANGED"] }
    ]);
  });
});

function semantic(overrides: Partial<SemanticTaskInputs> = {}): SemanticTaskInputs {
  return { ...emptySemanticTaskInputs(), ...overrides };
}

function hash(canonicalRef: string, character: string) {
  return { canonicalRef, sha256: character.repeat(64) };
}

function snapshot(
  taskId: string,
  semanticInputs: SemanticTaskInputs,
  runId = "run-old",
  states: ReadonlyMap<string, TaskRuntimeState> = new Map(),
  tasks: SnapshotManifest["tasks"] = [{ id: taskId, dependsOn: [] }]
): TaskInputSnapshot {
  return buildTaskInputSnapshot({
    manifest: { runId, graphVersion: runId === "run-old" ? 1 : 2, base: { commit: "f".repeat(40) }, tasks },
    taskId,
    states,
    semanticInputs
  });
}

function passed(entries: ReadonlyArray<readonly [string, string]>): Map<string, TaskRuntimeState> {
  return new Map(entries.map(([taskId, commit]) => [taskId, { status: "PASSED", commit }]));
}
