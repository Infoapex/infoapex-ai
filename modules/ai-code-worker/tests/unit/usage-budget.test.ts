import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { addUsage, emptyUsageTotals, evaluateUsageBudget } from "../../src/policy/usage-budget.js";

describe("usage budget policy", () => {
  it("passes when reported usage is under budget", () => {
    const totals = addUsage(emptyUsageTotals, {
      inputUncachedTokens: 10,
      cacheReadTokens: 0,
      cacheWriteTokens: 1,
      outputTokens: 5,
      costUsd: null
    });
    const result = evaluateUsageBudget(totals, {
      maximumAgentInvocations: 1,
      maximumRunInputUncachedTokens: 10,
      maximumRunCacheReadTokens: 0,
      maximumRunCacheWriteTokens: 1,
      maximumRunOutputTokens: 5,
      maximumRunCostUsd: null,
      onUnknownUsage: "block",
      maximumRunFiveHourPercent: null
    });

    assert.equal(result.status, "PASS");
    assert.deepEqual(result.findings, []);
  });

  it("blocks when a finite budget is exceeded", () => {
    const totals = {
      ...emptyUsageTotals,
      agentInvocations: 2,
      inputUncachedTokens: 21,
      cacheReadTokens: 0,
      cacheWriteTokens: 2,
      outputTokens: 10
    };
    const result = evaluateUsageBudget(totals, {
      maximumAgentInvocations: 2,
      maximumRunInputUncachedTokens: 20,
      maximumRunCacheReadTokens: 0,
      maximumRunCacheWriteTokens: 2,
      maximumRunOutputTokens: 10,
      maximumRunCostUsd: null,
      onUnknownUsage: "block",
      maximumRunFiveHourPercent: null
    });

    assert.equal(result.status, "BLOCK");
    assert.deepEqual(
      result.findings.map((finding) => [finding.code, finding.field]),
      [["USAGE_BUDGET_EXCEEDED", "inputUncachedTokens"]]
    );
  });

  it("does not convert unknown usage to zero", () => {
    const totals = addUsage(emptyUsageTotals, {
      inputUncachedTokens: null,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      outputTokens: 1,
      costUsd: null
    });
    const result = evaluateUsageBudget(totals, {
      maximumAgentInvocations: 1,
      maximumRunInputUncachedTokens: 100,
      maximumRunCacheReadTokens: 100,
      maximumRunCacheWriteTokens: 100,
      maximumRunOutputTokens: 100,
      maximumRunCostUsd: null,
      onUnknownUsage: "block",
      maximumRunFiveHourPercent: null
    });

    assert.equal(totals.inputUncachedTokens, null);
    assert.equal(result.status, "BLOCK");
    assert.equal(result.findings[0]?.code, "USAGE_UNKNOWN");
  });

  it("seeds the first invocation so known provider cost remains known", () => {
    const first = addUsage(emptyUsageTotals, {
      inputUncachedTokens: 10,
      cacheReadTokens: 20,
      cacheWriteTokens: 3,
      outputTokens: 4,
      costUsd: 0.0123
    });
    assert.equal(first.costUsd, 0.0123);

    const withUnknownRetry = addUsage(first, {
      inputUncachedTokens: 1,
      cacheReadTokens: 2,
      cacheWriteTokens: null,
      outputTokens: 1,
      costUsd: null
    });
    assert.equal(withUnknownRetry.costUsd, null);
    assert.equal(withUnknownRetry.cacheWriteTokens, null);
  });
});
