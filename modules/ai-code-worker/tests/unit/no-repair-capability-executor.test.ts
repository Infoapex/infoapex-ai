import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createNoRepairCapabilityExecutor } from "../../src/review/no-repair-capability-executor.js";
import type { RepairTask } from "../../src/repair/repair-task.js";

function repairTask(overrides: Partial<RepairTask> = {}): RepairTask {
  return {
    schemaVersion: "1.0",
    id: "REPAIR-001",
    runId: "run-1",
    graphVersion: 3,
    sourceFindingIds: ["REV-001"],
    allowedPaths: ["src/**"],
    forbiddenPaths: [],
    verify: [],
    dependsOn: [],
    maximumAttempts: 1,
    status: "READY",
    createdAt: "2026-08-15T10:00:00Z",
    ...overrides
  };
}

describe("createNoRepairCapabilityExecutor", () => {
  it("reports every task as FAILED with no commit", () => {
    const executor = createNoRepairCapabilityExecutor(() => "2026-08-15T10:00:00Z");
    const result = executor({ cycle: 1, tasks: [repairTask({ id: "REPAIR-001" }), repairTask({ id: "REPAIR-002" })], findings: [] });

    assert.deepEqual(result.taskOutcomes, [
      { taskId: "REPAIR-001", outcome: "FAILED", commit: null, evidenceRef: null },
      { taskId: "REPAIR-002", outcome: "FAILED", commit: null, evidenceRef: null }
    ]);
  });

  it("produces a schema-shaped review with a blocking capability-missing finding", () => {
    const executor = createNoRepairCapabilityExecutor(() => "2026-08-15T10:00:00Z");
    const result = executor({ cycle: 2, tasks: [repairTask({ sourceFindingIds: ["REV-001", "REV-002"] })], findings: [] });

    assert.equal(result.reviewAfterCycle.verdict, "fail");
    assert.equal(result.reviewAfterCycle.runId, "run-1");
    assert.equal(result.reviewAfterCycle.graphVersion, 3);
    assert.equal(result.reviewAfterCycle.findings.length, 1);
    assert.equal(result.reviewAfterCycle.findings[0]?.severity, "blocking");
    assert.match(result.reviewAfterCycle.findings[0]?.evidence ?? "", /REV-001, REV-002/);
  });

  it("handles an empty task list without throwing", () => {
    const executor = createNoRepairCapabilityExecutor(() => "2026-08-15T10:00:00Z");
    const result = executor({ cycle: 1, tasks: [], findings: [] });

    assert.deepEqual(result.taskOutcomes, []);
    assert.equal(result.reviewAfterCycle.runId, "unknown-run");
  });
});
