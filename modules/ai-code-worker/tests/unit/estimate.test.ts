import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { bucketHistoricalUsage, estimateUsageForPlan } from "../../src/benchmark/estimate.js";
import type { UsageCheckpoint } from "../../src/benchmark/usage-checkpoint.js";

describe("estimate", () => {
  it("buckets only task-scope end checkpoints with a known kind+risk and at least one non-null token", () => {
    const checkpoints: UsageCheckpoint[] = [
      endCheckpoint({ taskKind: "backend", taskRisk: "medium", outputTokens: 100 }),
      startCheckpoint({ taskKind: "backend", taskRisk: "medium" }), // start: excluded
      endCheckpoint({ taskKind: "backend", taskRisk: "medium", outputTokens: 200 }),
      runScopeEndCheckpoint({ outputTokens: 999 }), // run scope: excluded
      endCheckpoint({ taskKind: null, taskRisk: "medium", outputTokens: 50 }), // no kind: excluded
      endCheckpoint({ taskKind: "frontend", taskRisk: "low", outputTokens: 10, allNull: true }) // fully unknown: excluded
    ];

    const buckets = bucketHistoricalUsage(checkpoints);

    assert.deepEqual([...buckets.get("backend:medium")!], [100, 200]);
    assert.equal(buckets.get("frontend:low"), undefined);
    assert.equal(buckets.size, 1);
  });

  it("estimates per-task and total token ranges from historical buckets, and flags tasks with no history", () => {
    const history: UsageCheckpoint[] = [
      endCheckpoint({ taskKind: "backend", taskRisk: "medium", outputTokens: 100 }),
      endCheckpoint({ taskKind: "backend", taskRisk: "medium", outputTokens: 300 }),
      endCheckpoint({ taskKind: "backend", taskRisk: "medium", outputTokens: 200 })
    ];

    const estimate = estimateUsageForPlan({
      tasks: [
        { id: "TASK-A", kind: "backend", risk: "medium", acceptanceCriteria: ["a"] },
        { id: "TASK-B", kind: "docs", risk: "low", acceptanceCriteria: ["b"] }
      ],
      history
    });

    assert.equal(estimate.perTask.length, 2);
    assert.deepEqual(estimate.perTask[0]?.tokens, { low: 100, median: 200, high: 300 });
    assert.equal(estimate.perTask[0]?.sampleSize, 3);
    assert.equal(estimate.perTask[1]?.tokens, null);
    assert.equal(estimate.perTask[1]?.sampleSize, 0);
    assert.deepEqual(estimate.tasksWithoutHistory, ["TASK-B"]);
    // Total only sums the task(s) with history - TASK-B (no data) is excluded, not
    // assumed to cost 0.
    assert.deepEqual(estimate.totalTokens, { low: 100, median: 200, high: 300 });
    assert.ok(estimate.estimatedClaudePercent !== null);
  });

  it("returns null totals and a null claude-percent estimate when nothing in the plan has any history", () => {
    const estimate = estimateUsageForPlan({
      tasks: [{ id: "TASK-A", kind: "backend", risk: "high", acceptanceCriteria: ["a"] }],
      history: []
    });

    assert.equal(estimate.totalTokens, null);
    assert.equal(estimate.estimatedClaudePercent, null);
    assert.deepEqual(estimate.tasksWithoutHistory, ["TASK-A"]);
  });

  it("uses a caller-supplied calibration point set for the claude-percent estimate", () => {
    const history: UsageCheckpoint[] = [endCheckpoint({ taskKind: "backend", taskRisk: "low", outputTokens: 10_000 })];

    const estimate = estimateUsageForPlan({
      tasks: [{ id: "TASK-A", kind: "backend", risk: "low", acceptanceCriteria: ["a"] }],
      history,
      claudeCalibrationPoints: [{ tokens: 10_000, percent: 1 }]
    });

    assert.deepEqual(estimate.estimatedClaudePercent, { low: 1, median: 1, high: 1 });
  });
});

function endCheckpoint(input: {
  readonly taskKind: string | null;
  readonly taskRisk: string | null;
  readonly outputTokens: number;
  readonly allNull?: boolean;
}): UsageCheckpoint {
  return checkpoint({
    scope: "task",
    phase: "end",
    taskKind: input.taskKind as UsageCheckpoint["taskKind"],
    taskRisk: input.taskRisk as UsageCheckpoint["taskRisk"],
    outputTokens: input.allNull ? null : input.outputTokens
  });
}

function startCheckpoint(input: { readonly taskKind: string; readonly taskRisk: string }): UsageCheckpoint {
  return checkpoint({
    scope: "task",
    phase: "start",
    taskKind: input.taskKind as UsageCheckpoint["taskKind"],
    taskRisk: input.taskRisk as UsageCheckpoint["taskRisk"],
    outputTokens: null
  });
}

function runScopeEndCheckpoint(input: { readonly outputTokens: number }): UsageCheckpoint {
  return checkpoint({ scope: "run", phase: "end", taskKind: null, taskRisk: null, outputTokens: input.outputTokens });
}

function checkpoint(input: {
  readonly scope: UsageCheckpoint["scope"];
  readonly phase: UsageCheckpoint["phase"];
  readonly taskKind: UsageCheckpoint["taskKind"];
  readonly taskRisk: UsageCheckpoint["taskRisk"];
  readonly outputTokens: number | null;
}): UsageCheckpoint {
  return {
    schemaVersion: "1.0",
    checkpointId: "cp",
    runId: "run-1",
    taskId: "TASK-X",
    scope: input.scope,
    engine: "fake",
    phase: input.phase,
    createdAt: "2026-08-15T10:00:00Z",
    taskKind: input.taskKind,
    taskRisk: input.taskRisk,
    tokens: {
      inputUncachedTokens: null,
      cacheReadTokens: null,
      cacheWriteTokens: null,
      outputTokens: input.outputTokens,
      costUsd: null
    },
    contextEstimateTokens: null,
    percentUsedReported: null,
    percentUsedEstimated: null
  };
}
