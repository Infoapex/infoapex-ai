import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  aggregateNormalizedUsage,
  assessUsageTotals,
  UsageAggregationError,
  type UsageSample
} from "../../src/usage/normalized-usage.js";

describe("normalized usage accounting", () => {
  it("deduplicates resume replay and keeps only the last cumulative sample", () => {
    const first = sample("event-1", "invocation-1", 1, "cumulative", 100);
    const last = sample("event-2", "invocation-1", 2, "cumulative", 180);
    const report = aggregateNormalizedUsage([first, last, last]);

    assert.equal(report.sampleCount, 3);
    assert.equal(report.deduplicatedSampleCount, 2);
    assert.equal(report.totals.agentInvocations, 1);
    assert.equal(report.totals.inputUncachedTokens, 180);
    assert.equal(report.completeness, "complete");
    // economicVerdict no longer follows token/cost completeness (2026-09-02 quota-
    // percent decision, see quota-usage.ts) - it is "inconclusive" whenever no quota
    // reading is supplied, even when every token/cost field is known.
    assert.equal(report.economicVerdict, "inconclusive");
  });

  it("sums distinct retry and fallback invocations while preserving unknown fields", () => {
    const report = aggregateNormalizedUsage([
      sample("codex-failed", "codex-attempt", 1, "incremental", 100, null),
      sample("claude-done", "claude-fallback", 1, "incremental", 70, null)
    ]);

    assert.equal(report.totals.agentInvocations, 2);
    assert.equal(report.totals.inputUncachedTokens, 170);
    assert.equal(report.totals.costUsd, null);
    assert.equal(report.completeness, "partial");
    assert.equal(report.economicVerdict, "inconclusive");
    assert.deepEqual(report.unknownFields, ["costUsd"]);
  });

  it("fails closed when a replayed sample changes or a series mixes accounting modes", () => {
    assert.throws(
      () => aggregateNormalizedUsage([sample("same", "one", 1, "incremental", 1), sample("same", "one", 1, "incremental", 2)]),
      (error) => error instanceof UsageAggregationError && error.code === "DUPLICATE_SAMPLE_DRIFT"
    );
    assert.throws(
      () => aggregateNormalizedUsage([sample("a", "one", 1, "incremental", 1), sample("b", "one", 2, "cumulative", 2)]),
      (error) => error instanceof UsageAggregationError && error.code === "MIXED_ACCOUNTING_MODE"
    );
  });

  it("never converts an unavailable report into a comparable zero", () => {
    assert.deepEqual(assessUsageTotals(null), {
      completeness: "unavailable",
      economicVerdict: "inconclusive",
      unknownFields: ["inputUncachedTokens", "cacheReadTokens", "cacheWriteTokens", "outputTokens", "costUsd"]
    });
  });

  it("is comparable when quota is known, even if costUsd is unknown (Codex, subscription accounts)", () => {
    const totals = { agentInvocations: 1, inputUncachedTokens: 10, cacheReadTokens: 5, cacheWriteTokens: 0, outputTokens: 2, costUsd: null };
    const quota = { fiveHour: { percent: 4, windowMinutes: 300, source: "measured" as const }, weekly: { percent: null, windowMinutes: null, source: null } };

    const assessment = assessUsageTotals(totals, quota);

    assert.equal(assessment.economicVerdict, "comparable");
    assert.deepEqual(assessment.unknownFields, ["costUsd"]);
  });

  it("is inconclusive when quota is unknown, even if costUsd is known (never falls back to the old cost-based rule)", () => {
    const totals = { agentInvocations: 1, inputUncachedTokens: 10, cacheReadTokens: 5, cacheWriteTokens: 0, outputTokens: 2, costUsd: 0.05 };

    const assessment = assessUsageTotals(totals, null);

    assert.equal(assessment.economicVerdict, "inconclusive");
    assert.equal(assessment.completeness, "complete");
  });
});

function sample(
  sampleId: string,
  seriesId: string,
  sequence: number,
  accountingMode: "incremental" | "cumulative",
  input: number,
  costUsd: number | null = 0.01
): UsageSample {
  return {
    sampleId,
    seriesId,
    sequence,
    provider: seriesId.startsWith("claude") ? "claude" : "codex",
    parserVersion: seriesId.startsWith("claude") ? "claude-result.v1" : "codex-token-count.v1",
    accountingMode,
    usage: {
      inputUncachedTokens: input,
      cacheReadTokens: 10,
      cacheWriteTokens: 2,
      outputTokens: 5,
      costUsd
    }
  };
}
