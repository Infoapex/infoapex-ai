import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { runIndependentReviewAndRepair } from "../../src/run/independent-review-repair.js";
import type { IndependentReviewResult } from "../../src/review/independent-review.js";
import type { RepairCycleExecutionResult } from "../../src/repair/repair-cycle.js";
import { SchemaRegistry } from "../../src/schema/json-schema.js";

const registry = SchemaRegistry.load({ schemaDirectory: "schemas" });

function reviewWith(evidence: string | null): IndependentReviewResult {
  return {
    schemaVersion: "1.0",
    runId: "run-independent-review-repair",
    reviewId: "review-1",
    reviewer: "fake-reviewer",
    graphVersion: 1,
    createdAt: "2026-08-15T09:00:00Z",
    verdict: evidence === null ? "pass" : "fail",
    criterionCoverage: [
      { criterionId: "AC-01", verdict: "contradicted", tests: [], commands: ["test-a"], evidence: "coverage evidence" }
    ],
    findings:
      evidence === null
        ? []
        : [
            {
              id: "REV-001",
              severity: "blocking",
              category: "correctness",
              criterionIds: ["AC-01"],
              files: ["a/one.ts"],
              evidence
            }
          ]
  };
}

describe("independent review + repair wiring", () => {
  it("skips the repair loop entirely when the initial review has no blocking findings", () => {
    const taskCommits: Record<string, string> = { "TASK-A": "a".repeat(40) };

    const result = runIndependentReviewAndRepair({
      runId: "run-independent-review-repair",
      graphVersion: 1,
      taskCommits,
      maximumRepairCycles: 3,
      maximumAttemptsPerTask: 1,
      now: "2026-08-15T09:00:00Z",
      registry,
      reviewer: () => reviewWith(null),
      executeRepairCycle: () => {
        throw new Error("must not run a repair cycle when there is nothing to repair");
      }
    });

    assert.equal(result.status, "DONE");
    assert.equal(result.repairResult, null);
    assert.deepEqual(taskCommits, { "TASK-A": "a".repeat(40) });
  });

  it("merges a successful repair attempt's commit into taskCommits", () => {
    const taskCommits: Record<string, string> = { "TASK-A": "a".repeat(40) };

    const result = runIndependentReviewAndRepair({
      runId: "run-independent-review-repair",
      graphVersion: 1,
      taskCommits,
      maximumRepairCycles: 3,
      maximumAttemptsPerTask: 1,
      now: "2026-08-15T09:00:00Z",
      registry,
      reviewer: () => reviewWith("token accepted twice"),
      executeRepairCycle: ({ tasks }): RepairCycleExecutionResult => ({
        taskOutcomes: tasks.map((task) => ({ taskId: task.id, outcome: "PASSED", commit: "b".repeat(40), evidenceRef: null })),
        reviewAfterCycle: reviewWith(null)
      })
    });

    assert.equal(result.status, "DONE");
    assert.equal(result.repairResult?.status, "DONE");
    assert.equal(taskCommits["TASK-A"], "a".repeat(40));
    const repairTaskId = result.repairResult!.attempts[0]!.repairTaskId;
    assert.equal(taskCommits[repairTaskId], "b".repeat(40));
  });

  it("does not pollute taskCommits when repair exhausts its budget without resolving", () => {
    const taskCommits: Record<string, string> = { "TASK-A": "a".repeat(40) };

    const result = runIndependentReviewAndRepair({
      runId: "run-independent-review-repair",
      graphVersion: 1,
      taskCommits,
      maximumRepairCycles: 2,
      maximumAttemptsPerTask: 1,
      now: "2026-08-15T09:00:00Z",
      registry,
      reviewer: () => reviewWith("token accepted twice"),
      executeRepairCycle: ({ tasks }): RepairCycleExecutionResult => ({
        taskOutcomes: tasks.map((task) => ({ taskId: task.id, outcome: "FAILED", commit: null, evidenceRef: null })),
        reviewAfterCycle: reviewWith("token accepted twice")
      })
    });

    assert.equal(result.status, "BLOCKED");
    assert.deepEqual(taskCommits, { "TASK-A": "a".repeat(40) });
  });
});
