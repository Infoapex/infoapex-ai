import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { runRepairCycles, type RepairCycleExecutionResult } from "../../src/repair/repair-cycle.js";
import type { IndependentReviewResult } from "../../src/review/independent-review.js";
import { SchemaRegistry } from "../../src/schema/json-schema.js";

const registry = SchemaRegistry.load({ schemaDirectory: "schemas" });

function reviewWith(evidence: string | null): IndependentReviewResult {
  return {
    schemaVersion: "1.0",
    runId: "run-repair-cycle",
    reviewId: "review-cycle",
    reviewer: "fake-reviewer",
    graphVersion: 1,
    createdAt: "2026-08-14T12:00:00Z",
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

describe("bounded repair cycles", () => {
  it("resolves immediately when the initial review has no blocking findings", () => {
    const result = runRepairCycles({
      runId: "run-repair-cycle",
      graphVersion: 1,
      maximumRepairCycles: 3,
      maximumAttemptsPerTask: 1,
      now: "2026-08-14T12:00:00Z",
      registry,
      initialReview: reviewWith(null),
      executeCycle: () => {
        throw new Error("executeCycle should not be called when there is nothing to repair");
      }
    });

    assert.equal(result.status, "DONE");
    assert.equal(result.budget.consumedCycles, 0);
    assert.equal(result.budget.stopReason, null);
    assert.deepEqual(result.attempts, []);
  });

  it("stops as soon as a repair attempt resolves the finding", () => {
    const result = runRepairCycles({
      runId: "run-repair-cycle",
      graphVersion: 1,
      maximumRepairCycles: 3,
      maximumAttemptsPerTask: 1,
      now: "2026-08-14T12:00:00Z",
      registry,
      initialReview: reviewWith("token accepted twice"),
      executeCycle: ({ tasks }): RepairCycleExecutionResult => ({
        taskOutcomes: tasks.map((task) => ({ taskId: task.id, outcome: "PASSED", commit: "c".repeat(40), evidenceRef: null })),
        reviewAfterCycle: reviewWith(null)
      })
    });

    assert.equal(result.status, "DONE");
    assert.equal(result.budget.consumedCycles, 1);
    assert.equal(result.attempts.length, 1);
    assert.equal(result.attempts[0]?.outcome, "PASSED");
    assert.deepEqual(result.unresolvedFindingIds, []);
  });

  it("exhausts the repair budget when progress happens but the finding never resolves", () => {
    let call = 0;
    const result = runRepairCycles({
      runId: "run-repair-cycle",
      graphVersion: 1,
      maximumRepairCycles: 3,
      maximumAttemptsPerTask: 1,
      now: "2026-08-14T12:00:00Z",
      registry,
      initialReview: reviewWith("attempt 0"),
      executeCycle: ({ tasks }): RepairCycleExecutionResult => {
        call += 1;
        return {
          taskOutcomes: tasks.map((task) => ({ taskId: task.id, outcome: "FAILED", commit: null, evidenceRef: null })),
          reviewAfterCycle: reviewWith(`attempt ${call}`)
        };
      }
    });

    assert.equal(result.status, "BLOCKED");
    assert.equal(result.budget.stopReason, "cycles-exhausted");
    assert.equal(result.budget.consumedCycles, 3);
    assert.equal(result.budget.remainingCycles, 0);
    assert.equal(result.attempts.length, 3);
    assert.deepEqual(result.unresolvedFindingIds, ["REV-001"]);
  });

  it("stops early when the same finding evidence repeats without progress", () => {
    const result = runRepairCycles({
      runId: "run-repair-cycle",
      graphVersion: 1,
      maximumRepairCycles: 5,
      maximumAttemptsPerTask: 1,
      now: "2026-08-14T12:00:00Z",
      registry,
      initialReview: reviewWith("token accepted twice"),
      executeCycle: ({ tasks }): RepairCycleExecutionResult => ({
        taskOutcomes: tasks.map((task) => ({ taskId: task.id, outcome: "FAILED", commit: null, evidenceRef: null })),
        // Identical evidence every cycle - the repair attempt changes nothing.
        reviewAfterCycle: reviewWith("token accepted twice")
      })
    });

    assert.equal(result.status, "BLOCKED");
    assert.equal(result.budget.stopReason, "repeated-failure-no-progress");
    assert.ok(result.budget.consumedCycles < 5, "should stop well before exhausting the 5-cycle budget");
    assert.equal(result.signatures[0]?.occurrenceCount, 2);
    assert.equal(result.signatures[0]?.progressDetected, false);
  });

  it("blocks immediately when a blocking finding has no matching verification command", () => {
    const unverifiable: IndependentReviewResult = {
      ...reviewWith("unreproducible concern"),
      criterionCoverage: []
    };

    const result = runRepairCycles({
      runId: "run-repair-cycle",
      graphVersion: 1,
      maximumRepairCycles: 3,
      maximumAttemptsPerTask: 1,
      now: "2026-08-14T12:00:00Z",
      registry,
      initialReview: unverifiable,
      executeCycle: () => {
        throw new Error("executeCycle should not be called when no repair task compiles");
      }
    });

    assert.equal(result.status, "BLOCKED");
    assert.equal(result.budget.stopReason, "repeated-failure-no-progress");
    assert.equal(result.budget.consumedCycles, 0);
    assert.deepEqual(result.attempts, []);
  });
});
