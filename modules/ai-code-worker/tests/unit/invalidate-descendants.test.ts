import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { invalidateDescendants } from "../../src/graph/invalidate-descendants.js";
import type { TaskRuntimeState } from "../../src/graph/task-graph.js";
import type { SnapshotManifest } from "../../src/snapshots/task-input-snapshot.js";
import { SchemaRegistry } from "../../src/schema/json-schema.js";

const registry = SchemaRegistry.load({ schemaDirectory: "schemas" });

function manifest(): SnapshotManifest {
  return {
    runId: "run-invalidate",
    graphVersion: 1,
    base: { commit: "0".repeat(40) },
    tasks: [
      { id: "A", dependsOn: [] },
      { id: "B", dependsOn: ["A"] },
      { id: "C", dependsOn: ["B"] },
      { id: "D", dependsOn: [] }
    ]
  };
}

function passedStates(): Map<string, TaskRuntimeState> {
  return new Map([
    ["A", { status: "PASSED", commit: "a".repeat(40) }],
    ["B", { status: "PASSED", commit: "b".repeat(40) }],
    ["C", { status: "PASSED", commit: "c".repeat(40) }],
    ["D", { status: "PASSED", commit: "d".repeat(40) }]
  ]);
}

describe("descendant invalidation", () => {
  it("marks only the transitive descendants of the changed task STALE", () => {
    const result = invalidateDescendants({
      manifest: manifest(),
      states: passedStates(),
      changedTaskId: "A",
      newCommit: "e".repeat(40),
      registry
    });

    assert.deepEqual(result.staleTaskIds, ["B", "C"]);
    assert.equal(result.states.get("A")?.status, "PASSED");
    assert.equal(result.states.get("A")?.commit, "e".repeat(40));
    assert.equal(result.states.get("B")?.status, "STALE");
    assert.equal(result.states.get("B")?.commit, undefined);
    assert.equal(result.states.get("C")?.status, "STALE");
  });

  it("leaves unrelated tasks untouched", () => {
    const result = invalidateDescendants({
      manifest: manifest(),
      states: passedStates(),
      changedTaskId: "A",
      newCommit: "e".repeat(40),
      registry
    });

    assert.equal(result.states.get("D")?.status, "PASSED");
    assert.equal(result.states.get("D")?.commit, "d".repeat(40));
  });

  it("rebuilds a snapshot only for the descendant whose dependencies are all currently passed", () => {
    const result = invalidateDescendants({
      manifest: manifest(),
      states: passedStates(),
      changedTaskId: "A",
      newCommit: "e".repeat(40),
      registry
    });

    // B's only dependency (A) is passed again immediately, so it gets a fresh snapshot.
    // C depends on B, which is now STALE (not yet re-passed) - no snapshot for C yet.
    assert.deepEqual(
      result.newSnapshots.map((snapshot) => snapshot.taskId),
      ["B"]
    );
    assert.deepEqual(result.newSnapshots[0]?.directDependencies, [{ taskId: "A", commit: "e".repeat(40) }]);
    assert.deepEqual(registry.validate("task-input-snapshot.schema.json", result.newSnapshots[0]), {
      valid: true,
      errors: []
    });
  });

  it("produces no stale tasks or snapshots when the changed task has no descendants", () => {
    const result = invalidateDescendants({
      manifest: manifest(),
      states: passedStates(),
      changedTaskId: "D",
      newCommit: "f".repeat(40),
      registry
    });

    assert.deepEqual(result.staleTaskIds, []);
    assert.deepEqual(result.newSnapshots, []);
  });
});
