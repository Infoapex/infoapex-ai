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
      onUnknownUsage: "block"
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
      onUnknownUsage: "block"
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
      onUnknownUsage: "block"
    });

    assert.equal(totals.inputUncachedTokens, null);
    assert.equal(result.status, "BLOCK");
    assert.equal(result.findings[0]?.code, "USAGE_UNKNOWN");
  });
});
