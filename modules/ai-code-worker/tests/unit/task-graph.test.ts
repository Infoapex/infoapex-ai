import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildTaskGraph,
  dependencyClosure,
  descendantsOf,
  readyTasks,
  TaskGraphError,
  type TaskRuntimeState
} from "../../src/graph/task-graph.js";

describe("task graph", () => {
  it("builds stable topological order and ready sets", () => {
    const graph = buildTaskGraph([
      { id: "BACKEND-01", dependsOn: ["CONTRACT-01"] },
      { id: "FRONTEND-01", dependsOn: [] },
      { id: "CONTRACT-01", dependsOn: [] }
    ]);

    assert.deepEqual(graph.topologicalOrder, ["CONTRACT-01", "BACKEND-01", "FRONTEND-01"]);
    assert.deepEqual(readyTasks(graph, new Map()), ["CONTRACT-01", "FRONTEND-01"]);

    const states = new Map<string, TaskRuntimeState>([
      ["CONTRACT-01", { status: "PASSED", commit: "1".repeat(40) }],
      ["FRONTEND-01", { status: "RUNNING" }]
    ]);

    assert.deepEqual(readyTasks(graph, states), ["BACKEND-01"]);
  });

  it("detects unknown dependencies and cycles", () => {
    assert.throws(
      () => buildTaskGraph([{ id: "BACKEND-01", dependsOn: ["MISSING-01"] }]),
      (error) => error instanceof TaskGraphError && error.code === "UNKNOWN_DEPENDENCY"
    );

    assert.throws(
      () =>
        buildTaskGraph([
          { id: "A", dependsOn: ["B"] },
          { id: "B", dependsOn: ["A"] }
        ]),
      (error) => error instanceof TaskGraphError && error.code === "CYCLE_DETECTED"
    );
  });

  it("computes deterministic transitive closure and descendants for diamond graphs", () => {
    const graph = buildTaskGraph([
      { id: "A", dependsOn: [] },
      { id: "B", dependsOn: ["A"] },
      { id: "C", dependsOn: ["A"] },
      { id: "D", dependsOn: ["B", "C"] },
      { id: "E", dependsOn: [] }
    ]);

    assert.deepEqual(dependencyClosure(graph, "D"), ["A", "B", "C"]);
    assert.deepEqual(descendantsOf(graph, "A"), ["B", "C", "D"]);
    assert.deepEqual(descendantsOf(graph, "E"), []);
  });
});
