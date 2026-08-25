import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { evaluatePilotValueGate, type PilotBaseline, type PilotTaskResult } from "../../src/pilot/value-gate.js";

describe("pilot value gate", () => {
  it("passes when functional and comparable metrics stay within preregistered thresholds", () => {
    const report = evaluatePilotValueGate(baseline(), [
      done("A", { elapsedTime: 10, humanActiveMinutes: 4, humanInterventions: 0 }, { elapsedTime: 10, humanActiveMinutes: 4, humanInterventions: 0 }),
      done("B", { elapsedTime: 12, humanActiveMinutes: 5, humanInterventions: 1 }, { elapsedTime: 10, humanActiveMinutes: 5, humanInterventions: 1 }),
      done("C", { elapsedTime: 13, humanActiveMinutes: 5, humanInterventions: 1 }, { elapsedTime: 10, humanActiveMinutes: 5, humanInterventions: 1 })
    ]);

    assert.equal(report.verdict, "PASS");
    assert.equal(report.doneTasks, 3);
    assert.deepEqual(report.findings, []);
  });

  it("fails when minimum DONE tasks or worker-caused failure limits are violated", () => {
    const report = evaluatePilotValueGate(baseline(), [
      done("A"),
      failed("B", true),
      failed("C", true)
    ]);

    assert.equal(report.verdict, "FAIL");
    assert.deepEqual(
      report.findings.map((finding) => finding.code),
      ["PILOT_MINIMUM_DONE_TASKS_NOT_MET", "PILOT_CONSECUTIVE_WORKER_FAILURES"]
    );
  });

  it("requires review when a required metric exceeds its threshold", () => {
    const report = evaluatePilotValueGate(baseline(), [
      done("A", { elapsedTime: 20, humanActiveMinutes: 4, humanInterventions: 0 }, { elapsedTime: 10, humanActiveMinutes: 4, humanInterventions: 0 }),
      done("B", { elapsedTime: 20, humanActiveMinutes: 4, humanInterventions: 0 }, { elapsedTime: 10, humanActiveMinutes: 4, humanInterventions: 0 }),
      done("C", { elapsedTime: 20, humanActiveMinutes: 4, humanInterventions: 0 }, { elapsedTime: 10, humanActiveMinutes: 4, humanInterventions: 0 })
    ]);

    assert.equal(report.verdict, "REVIEW_REQUIRED");
    assert.ok(report.findings.some((finding) => finding.message.includes("elapsedTime ratio 2")));
  });

  it("skips conditional cost when either route lacks comparable cost data", () => {
    const report = evaluatePilotValueGate(baseline(), [done("A"), done("B"), done("C")]);
    const cost = report.metricResults.find((metric) => metric.metric === "reportedCostUsd");

    assert.equal(report.verdict, "PASS");
    assert.equal(cost?.status, "SKIPPED");
  });

  it("uses the absolute intervention cap when baseline interventions are zero", () => {
    const report = evaluatePilotValueGate(baseline(), [
      done("A", { elapsedTime: 10, humanActiveMinutes: 4, humanInterventions: 2 }, { elapsedTime: 10, humanActiveMinutes: 4, humanInterventions: 0 }),
      done("B", { elapsedTime: 10, humanActiveMinutes: 4, humanInterventions: 2 }, { elapsedTime: 10, humanActiveMinutes: 4, humanInterventions: 0 }),
      done("C", { elapsedTime: 10, humanActiveMinutes: 4, humanInterventions: 0 }, { elapsedTime: 10, humanActiveMinutes: 4, humanInterventions: 0 })
    ]);

    assert.equal(report.verdict, "REVIEW_REQUIRED");
    assert.ok(report.findings.some((finding) => finding.message.includes("absolute cap 3")));
  });

  it("fails immediately on guardrail violations", () => {
    const report = evaluatePilotValueGate(baseline(), [
      done("A"),
      { ...done("B"), guardrailViolation: true },
      done("C")
    ]);

    assert.equal(report.verdict, "FAIL");
    assert.equal(report.findings[0]?.code, "PILOT_GUARDRAIL_VIOLATION");
  });
});

function baseline(): PilotBaseline {
  return {
    minimumDoneTasks: 2,
    maximumConsecutiveWorkerCausedFailures: 2,
    requiredComparableMetrics: ["elapsedTime", "humanActiveMinutes", "humanInterventions"],
    conditionalComparableMetrics: ["reportedCostUsd"],
    thresholds: {
      maximumElapsedTimeRatio: 1.5,
      maximumReportedCostRatio: 1.5,
      maximumHumanActiveMinutesRatio: 1.5,
      maximumHumanInterventionsRatio: 1.5,
      maximumHumanInterventionsPerTask: 1
    }
  };
}

function done(
  taskId: string,
  worker: PilotTaskResult["worker"] = { elapsedTime: 10, humanActiveMinutes: 4, humanInterventions: 0 },
  manual: PilotTaskResult["baseline"] = { elapsedTime: 10, humanActiveMinutes: 4, humanInterventions: 0 }
): PilotTaskResult {
  return {
    taskId,
    status: "DONE",
    worker,
    baseline: manual
  };
}

function failed(taskId: string, workerCausedFailure: boolean): PilotTaskResult {
  return {
    taskId,
    status: "FAILED",
    workerCausedFailure,
    worker: { elapsedTime: 10, humanActiveMinutes: 4, humanInterventions: 0 },
    baseline: { elapsedTime: 10, humanActiveMinutes: 4, humanInterventions: 0 }
  };
}
