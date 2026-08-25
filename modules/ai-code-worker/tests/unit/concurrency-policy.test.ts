import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { partitionIntoWaves, tasksOverlap, type ConcurrencyScope } from "../../src/policy/concurrency-policy.js";

function scope(taskId: string, allowedPaths: readonly string[], concurrencyKeys: readonly string[] = []): ConcurrencyScope {
  return { taskId, allowedPaths, concurrencyKeys };
}

describe("concurrency policy", () => {
  it("declares tasks compatible when paths and concurrency keys are fully disjoint", () => {
    const a = scope("A", ["src/backend/**"], ["backend"]);
    const b = scope("B", ["src/frontend/**"], ["frontend"]);

    assert.deepEqual(tasksOverlap(a, b), { compatible: true, reason: null, detail: null });
  });

  it("blocks tasks that share a concurrencyKey even with disjoint paths", () => {
    const a = scope("A", ["src/backend/**"], ["shared-key"]);
    const b = scope("B", ["src/frontend/**"], ["shared-key"]);
    const result = tasksOverlap(a, b);

    assert.equal(result.compatible, false);
    assert.equal(result.reason, "concurrencyKeyOverlap");
  });

  it("blocks tasks with identical allowedPaths", () => {
    const a = scope("A", ["src/shared.ts"]);
    const b = scope("B", ["src/shared.ts"]);
    const result = tasksOverlap(a, b);

    assert.equal(result.compatible, false);
    assert.equal(result.reason, "pathOverlap");
  });

  it("blocks tasks whose glob directory trees overlap", () => {
    const a = scope("A", ["src/**"]);
    const b = scope("B", ["src/utils/**"]);
    const result = tasksOverlap(a, b);

    assert.equal(result.compatible, false);
    assert.equal(result.reason, "pathOverlap");
  });

  it("does not treat sibling directories with a shared string prefix as overlapping", () => {
    const a = scope("A", ["src/foo/**"]);
    const b = scope("B", ["src/foo-bar/**"]);

    assert.equal(tasksOverlap(a, b).compatible, true);
  });

  it("treats ** as overlapping with anything", () => {
    const a = scope("A", ["**"]);
    const b = scope("B", ["docs/**"]);
    const result = tasksOverlap(a, b);

    assert.equal(result.compatible, false);
    assert.equal(result.reason, "pathOverlap");
  });

  it("treats an exact file inside a globbed directory as overlapping", () => {
    const a = scope("A", ["src/utils/output.txt"]);
    const b = scope("B", ["src/utils/**"]);

    assert.equal(tasksOverlap(a, b).compatible, false);
  });

  describe("partitionIntoWaves", () => {
    it("keeps a single-task wave per call when maximumParallelWriters is 1", () => {
      const scopes = new Map([
        ["A", scope("A", ["src/a/**"])],
        ["B", scope("B", ["src/b/**"])],
        ["C", scope("C", ["src/c/**"])]
      ]);
      const waves = partitionIntoWaves(["A", "B", "C"], scopes, 1);

      assert.deepEqual(waves, [["A"], ["B"], ["C"]]);
    });

    it("batches compatible tasks together up to the parallel cap", () => {
      const scopes = new Map([
        ["A", scope("A", ["src/a/**"])],
        ["B", scope("B", ["src/b/**"])],
        ["C", scope("C", ["src/c/**"])]
      ]);
      const waves = partitionIntoWaves(["A", "B", "C"], scopes, 2);

      assert.deepEqual(waves, [["A", "B"], ["C"]]);
    });

    it("separates incompatible tasks into different waves even under a higher cap", () => {
      const scopes = new Map([
        ["A", scope("A", ["src/shared/**"])],
        ["B", scope("B", ["src/shared/**"])],
        ["C", scope("C", ["src/other/**"])]
      ]);
      const waves = partitionIntoWaves(["A", "B", "C"], scopes, 3);

      assert.deepEqual(waves, [["A", "C"], ["B"]]);
    });
  });
});
