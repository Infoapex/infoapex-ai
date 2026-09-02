import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { toSpanAttributes } from "../../src/telemetry/redact-attributes.js";

describe("telemetry: span attribute allowlist (ADR-0012)", () => {
  it("keeps allowlisted scalar fields as-is", () => {
    const attributes = toSpanAttributes({ taskId: "TASK-01", exitCode: 0, complete: true });
    assert.deepEqual(attributes, { taskId: "TASK-01", exitCode: 0, complete: true });
  });

  it("drops any payload key that is not on the allowlist, including future/unknown ones", () => {
    const attributes = toSpanAttributes({ taskId: "TASK-01", somethingNoOneReviewedYet: "value", prompt: "do the thing" });
    assert.deepEqual(attributes, { taskId: "TASK-01" });
  });

  it("never passes through a raw filesystem path, converting changedPaths to a count instead", () => {
    const attributes = toSpanAttributes({
      taskId: "TASK-01",
      path: "C:\\Users\\alex\\repo\\worktree",
      changedPaths: ["src/a.ts", "src/b.ts", "src/c.ts"]
    });
    assert.equal(attributes.path, undefined);
    assert.equal(attributes.changedPaths, undefined);
    assert.equal(attributes.changedPathCount, 3);
  });

  it("drops an allowlisted key's value entirely if it looks like a secret, instead of exporting a [REDACTED] placeholder", () => {
    const attributes = toSpanAttributes({ commit: 'api_key: "abcdefgh12345678"' });
    assert.equal(attributes.commit, undefined);
  });

  it("passes through a clean homogeneous string array and drops it if any element looks like a secret", () => {
    const clean = toSpanAttributes({ taskIds: ["TASK-01", "TASK-02"] });
    assert.deepEqual(clean.taskIds, ["TASK-01", "TASK-02"]);

    const dirty = toSpanAttributes({ taskIds: ["TASK-01", 'token: "abcdefgh12345678"'] });
    assert.equal(dirty.taskIds, undefined);
  });

  it("drops non-primitive, non-array values (objects, null) even on an allowlisted key", () => {
    const attributes = toSpanAttributes({ taskId: "TASK-01", commit: null, outputSha256: { nested: true } });
    assert.deepEqual(attributes, { taskId: "TASK-01" });
  });
});
