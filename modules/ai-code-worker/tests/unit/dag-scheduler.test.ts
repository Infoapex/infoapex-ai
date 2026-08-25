import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildTaskGraph, type TaskRuntimeState } from "../../src/graph/task-graph.js";
import { nextDispatchWave, type DispatchTaskScope } from "../../src/run/dag-scheduler.js";

function scopesFrom(entries: ReadonlyArray<readonly [string, readonly string[]]>): Map<string, DispatchTaskScope> {
  return new Map(entries.map(([id, allowedPaths]) => [id, { id, allowedPaths, concurrencyKeys: [] }]));
}

describe("dag scheduler", () => {
  it("degenerates to single-task waves in the same order as topologicalOrder when maximumParallelWriters is 1", () => {
    const graph = buildTaskGraph([
      { id: "A", dependsOn: [] },
      { id: "B", dependsOn: ["A"] },
      { id: "C", dependsOn: [] }
    ]);
    const scopes = scopesFrom([
      ["A", ["src/a/**"]],
      ["B", ["src/b/**"]],
      ["C", ["src/c/**"]]
    ]);

    const states = new Map<string, TaskRuntimeState>();
    const dispatched: string[] = [];

    for (let i = 0; i < graph.topologicalOrder.length; i += 1) {
      const wave = nextDispatchWave(graph, scopes, states, 1);
      assert.equal(wave.length, 1);
      const taskId = wave[0]!;
      dispatched.push(taskId);
      states.set(taskId, { status: "PASSED", commit: `commit-${taskId}` });
    }

    assert.deepEqual(dispatched, graph.topologicalOrder);
  });

  it("batches two independent, compatible ready tasks into one wave under a higher cap", () => {
    const graph = buildTaskGraph([
      { id: "A", dependsOn: [] },
      { id: "B", dependsOn: [] }
    ]);
    const scopes = scopesFrom([
      ["A", ["src/a/**"]],
      ["B", ["src/b/**"]]
    ]);
    const states = new Map<string, TaskRuntimeState>();

    const wave = nextDispatchWave(graph, scopes, states, 2);

    assert.deepEqual([...wave].sort(), ["A", "B"]);
  });

  it("never batches two ready tasks with overlapping allowedPaths, even under a higher cap", () => {
    const graph = buildTaskGraph([
      { id: "A", dependsOn: [] },
      { id: "B", dependsOn: [] }
    ]);
    const scopes = scopesFrom([
      ["A", ["src/shared/**"]],
      ["B", ["src/shared/**"]]
    ]);
    const states = new Map<string, TaskRuntimeState>();

    const wave = nextDispatchWave(graph, scopes, states, 5);

    assert.equal(wave.length, 1);
  });

  it("only includes a dependent task once its dependency has passed", () => {
    const graph = buildTaskGraph([
      { id: "A", dependsOn: [] },
      { id: "B", dependsOn: ["A"] }
    ]);
    const scopes = scopesFrom([
      ["A", ["src/a/**"]],
      ["B", ["src/b/**"]]
    ]);
    const states = new Map<string, TaskRuntimeState>();

    assert.deepEqual(nextDispatchWave(graph, scopes, states, 5), ["A"]);

    states.set("A", { status: "PASSED", commit: "abc" });
    assert.deepEqual(nextDispatchWave(graph, scopes, states, 5), ["B"]);
  });

  it("returns an empty wave when nothing is ready", () => {
    const graph = buildTaskGraph([{ id: "A", dependsOn: [] }]);
    const scopes = scopesFrom([["A", ["src/a/**"]]]);
    const states = new Map<string, TaskRuntimeState>([["A", { status: "PASSED", commit: "abc" }]]);

    assert.deepEqual(nextDispatchWave(graph, scopes, states, 5), []);
  });
});
