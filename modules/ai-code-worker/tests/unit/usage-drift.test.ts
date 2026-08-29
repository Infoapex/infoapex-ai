import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { evaluateUsageDrift } from "../../src/benchmark/usage-drift.js";
import type { ProfiledUsageCheckpoint } from "../../src/benchmark/usage-checkpoint.js";

describe("usage drift", () => {
  it("computes a clean predicted-versus-actual stage and tokens-per-percentage-point", () => {
    const report = evaluateUsageDrift({
      checkpoints: [checkpoint("start", 1000, 51), checkpoint("end", 1600, 55)],
      planId: "ICM",
      profile: "codex:gpt-5.6-sol:high"
    });

    assert.equal(report.status, "GREEN");
    assert.equal(report.stages[0]?.actualTokens, 600);
    assert.equal(report.stages[0]?.usageDeltaPercentagePoints, 4);
    assert.equal(report.stages[0]?.observedTokensPerPercentagePoint, 150);
    assert.equal(report.meanAbsolutePercentageError, 0);
    assert.equal(report.rangeHitRate, 1);
  });

  it("marks a stage non-comparable when another rollout changed during the interval", () => {
    const end = { ...checkpoint("end", 1600, 55), parallelSessionCount: 1 };
    const report = evaluateUsageDrift({ checkpoints: [checkpoint("start", 1000, 51), end], planId: "ICM" });

    assert.equal(report.status, "NOT_COMPARABLE");
    assert.equal(report.stages[0]?.status, "NOT_COMPARABLE");
    assert.ok(report.stages[0]?.reasons.includes("PARALLEL_CODEX_SESSION_DETECTED"));
  });

  it("does not invent prediction accuracy when a stage has no preregistered prediction", () => {
    const start = { ...checkpoint("start", 1000, 51), prediction: null };
    const report = evaluateUsageDrift({ checkpoints: [start, checkpoint("end", 1600, 55)], planId: "ICM" });

    assert.equal(report.status, "INSUFFICIENT_HISTORY");
    assert.equal(report.meanAbsolutePercentageError, null);
    assert.equal(report.stages[0]?.observedTokensPerPercentagePoint, 150);
  });

  it("keeps token prediction comparable across a rate-limit reset while refusing a false tokens-per-pp rate", () => {
    const end = {
      ...checkpoint("end", 1600, 15),
      rateLimitResetsAt: 10_000_000_000
    };
    const report = evaluateUsageDrift({ checkpoints: [checkpoint("start", 1000, 75), end], planId: "ICM" });

    assert.equal(report.status, "GREEN");
    assert.equal(report.predictedStageCount, 1);
    assert.equal(report.stages[0]?.actualTokens, 600);
    assert.equal(report.stages[0]?.tokenErrorPercent, 0);
    assert.equal(report.stages[0]?.usageMappingStatus, "NOT_COMPARABLE");
    assert.equal(report.stages[0]?.observedTokensPerPercentagePoint, null);
    assert.ok(report.stages[0]?.reasons.includes("RATE_LIMIT_RESET_CHANGED"));
  });
});

function checkpoint(phase: "start" | "end", totalTokens: number, usedPercent: number): ProfiledUsageCheckpoint {
  return {
    schemaVersion: "1.1",
    checkpointId: `cp-${phase}`,
    runId: "ICM",
    taskId: "ICM-00",
    scope: "development",
    engine: "codex",
    phase,
    createdAt: phase === "start" ? "2026-08-28T10:00:00Z" : "2026-08-28T10:05:00Z",
    taskKind: "backend",
    taskRisk: "high",
    tokens: {
      inputUncachedTokens: totalTokens,
      cacheReadTokens: null,
      cacheWriteTokens: null,
      outputTokens: null,
      costUsd: null
    },
    contextEstimateTokens: totalTokens,
    percentUsedReported: usedPercent,
    percentUsedEstimated: null,
    model: "gpt-5.6-sol",
    reasoningEffort: "high",
    modelContextWindow: 1_050_000,
    rateLimitWindowMinutes: 300,
    rateLimitResetsAt: 9999999999,
    calibrationProfileId: "codex:gpt-5.6-sol:high",
    sessionFingerprint: "0123456789abcdef",
    parallelSessionCount: 0,
    prediction: phase === "start" ? { lowTokens: 500, medianTokens: 600, highTokens: 700, source: "plan" } : null
  };
}
