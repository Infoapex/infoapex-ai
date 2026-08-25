import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildTaskInputSnapshot,
  TaskInputSnapshotError,
  type SnapshotManifest
} from "../../src/snapshots/task-input-snapshot.js";
import { canonicalJson, sha256 } from "../../src/manifest/normalize.js";
import { SchemaRegistry, type JsonValue } from "../../src/schema/json-schema.js";
import type { TaskRuntimeState } from "../../src/graph/task-graph.js";

const registry = SchemaRegistry.load({ schemaDirectory: "schemas" });

describe("task input snapshot", () => {
  it("builds a deterministic snapshot from dependency closure only", () => {
    const states = passedStates([
      ["CONTRACT-01", "1".repeat(40)],
      ["BACKEND-01", "2".repeat(40)],
      ["FRONTEND-01", "3".repeat(40)]
    ]);
    const snapshot = buildTaskInputSnapshot({
      manifest: manifest(),
      taskId: "API-01",
      states,
      registry
    });
    const repeat = buildTaskInputSnapshot({
      manifest: manifest(),
      taskId: "API-01",
      states,
      registry
    });

    assert.deepEqual(snapshot.directDependencies, [{ taskId: "BACKEND-01", commit: "2".repeat(40) }]);
    assert.deepEqual(snapshot.transitiveDependencies, [
      { taskId: "CONTRACT-01", commit: "1".repeat(40) },
      { taskId: "BACKEND-01", commit: "2".repeat(40) }
    ]);
    assert.equal(snapshot.snapshotMetadataSha256, repeat.snapshotMetadataSha256);
    assert.equal(snapshot.inputTree, repeat.inputTree);
    assert.equal(snapshot.transitiveDependencies.some((dependency) => dependency.taskId === "FRONTEND-01"), false);
    assert.deepEqual(registry.validate("task-input-snapshot.schema.json", snapshot), { valid: true, errors: [] });
  });

  it("deduplicates diamond dependency commits through stable closure", () => {
    const snapshot = buildTaskInputSnapshot({
      manifest: {
        ...manifest(),
        tasks: [
          { id: "A", dependsOn: [] },
          { id: "B", dependsOn: ["A"] },
          { id: "C", dependsOn: ["A"] },
          { id: "D", dependsOn: ["B", "C"] }
        ]
      },
      taskId: "D",
      states: passedStates([
        ["A", "a".repeat(40)],
        ["B", "b".repeat(40)],
        ["C", "c".repeat(40)]
      ]),
      registry
    });

    assert.deepEqual(snapshot.transitiveDependencies, [
      { taskId: "A", commit: "a".repeat(40) },
      { taskId: "B", commit: "b".repeat(40) },
      { taskId: "C", commit: "c".repeat(40) }
    ]);
  });

  it("rejects dependencies that are passed without verified commits", () => {
    assert.throws(
      () =>
        buildTaskInputSnapshot({
          manifest: manifest(),
          taskId: "API-01",
          states: new Map([["BACKEND-01", { status: "PASSED" }]]),
          registry
        }),
      (error) => error instanceof TaskInputSnapshotError && error.code === "DEPENDENCY_MISSING_COMMIT"
    );
  });

  it("rejects dependencies that are not passed", () => {
    assert.throws(
      () =>
        buildTaskInputSnapshot({
          manifest: manifest(),
          taskId: "API-01",
          states: new Map([["BACKEND-01", { status: "PENDING" }]]),
          registry
        }),
      (error) => error instanceof TaskInputSnapshotError && error.code === "DEPENDENCY_NOT_PASSED"
    );
  });

  it("computes metadata digest without including its own digest field", () => {
    const snapshot = buildTaskInputSnapshot({
      manifest: manifest(),
      taskId: "BACKEND-01",
      states: passedStates([["CONTRACT-01", "1".repeat(40)]]),
      registry
    });
    const { snapshotMetadataSha256, ...withoutDigest } = snapshot;

    assert.equal(snapshotMetadataSha256, sha256(canonicalJson(withoutDigest as unknown as JsonValue)));
  });
});

function manifest(): SnapshotManifest {
  return {
    runId: "run-snapshot-1",
    graphVersion: 1,
    base: {
      commit: "f".repeat(40)
    },
    tasks: [
      { id: "CONTRACT-01", dependsOn: [] },
      { id: "BACKEND-01", dependsOn: ["CONTRACT-01"] },
      { id: "API-01", dependsOn: ["BACKEND-01"] },
      { id: "FRONTEND-01", dependsOn: [] }
    ]
  };
}

function passedStates(entries: ReadonlyArray<readonly [string, string]>): Map<string, TaskRuntimeState> {
  return new Map(entries.map(([taskId, commit]) => [taskId, { status: "PASSED", commit }]));
}
