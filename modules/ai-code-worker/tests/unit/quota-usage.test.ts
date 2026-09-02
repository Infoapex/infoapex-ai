import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  claudeQuotaUsageFromTokens,
  codexQuotaUsage,
  evaluateQuotaBudget,
  quotaEconomicVerdict,
  unknownQuotaUsage
} from "../../src/usage/quota-usage.js";
import type { CodexSessionUsageSummary } from "../../src/benchmark/read-codex-session.js";

describe("quota-usage", () => {
  it("unknownQuotaUsage has no known percent on either window", () => {
    const quota = unknownQuotaUsage();

    assert.equal(quota.fiveHour.percent, null);
    assert.equal(quota.fiveHour.source, null);
    assert.equal(quota.weekly.percent, null);
  });

  it("codexQuotaUsage maps a real session summary to measured percent on both windows", () => {
    const summary: CodexSessionUsageSummary = {
      totalTokenUsage: null,
      usedPercent: 4,
      windowMinutes: 300,
      resetsAt: 111,
      secondaryUsedPercent: 6,
      secondaryWindowMinutes: 10080,
      secondaryResetsAt: 222,
      planType: "plus",
      sessionId: null,
      model: null,
      reasoningEffort: null,
      modelContextWindow: null
    };

    const quota = codexQuotaUsage(summary);

    assert.deepEqual(quota, {
      fiveHour: { percent: 4, windowMinutes: 300, source: "measured" },
      weekly: { percent: 6, windowMinutes: 10080, source: "measured" }
    });
  });

  it("codexQuotaUsage returns unknown (not zero) when there is no session summary to read", () => {
    assert.deepEqual(codexQuotaUsage(null), unknownQuotaUsage());
  });

  it("claudeQuotaUsageFromTokens is always 'estimated', never 'measured', and only fills the 5-hour window", () => {
    const quota = claudeQuotaUsageFromTokens(20_000, 10_000);

    assert.deepEqual(quota.fiveHour, { percent: 2, windowMinutes: 300, source: "estimated" });
    assert.equal(quota.weekly.percent, null);
  });

  it("claudeQuotaUsageFromTokens returns unknown when the token total itself is unknown", () => {
    assert.deepEqual(claudeQuotaUsageFromTokens(null, 10_000), unknownQuotaUsage());
  });

  it("economicVerdict is comparable for either source, as long as the 5-hour percent is known", () => {
    assert.equal(quotaEconomicVerdict(codexQuotaUsage({ ...emptySummary(), usedPercent: 4 })), "comparable");
    assert.equal(quotaEconomicVerdict(claudeQuotaUsageFromTokens(1000, 500)), "comparable");
  });

  it("economicVerdict is inconclusive when quota is null or the 5-hour percent itself is unknown", () => {
    assert.equal(quotaEconomicVerdict(null), "inconclusive");
    assert.equal(quotaEconomicVerdict(unknownQuotaUsage()), "inconclusive");
  });

  describe("evaluateQuotaBudget", () => {
    it("passes with no findings when no budget is declared, regardless of quota", () => {
      const result = evaluateQuotaBudget(unknownQuotaUsage(), null);

      assert.deepEqual(result, { status: "PASS", findings: [] });
    });

    it("blocks when the known percent exceeds the declared maximum", () => {
      const quota = claudeQuotaUsageFromTokens(50_000, 10_000); // 5%
      const result = evaluateQuotaBudget(quota, 4);

      assert.equal(result.status, "BLOCK");
      assert.equal(result.findings[0]?.code, "QUOTA_BUDGET_EXCEEDED");
    });

    it("passes when the known percent is within the declared maximum", () => {
      const quota = claudeQuotaUsageFromTokens(30_000, 10_000); // 3%
      const result = evaluateQuotaBudget(quota, 4);

      assert.equal(result.status, "PASS");
    });

    it("treats an unknown percent as allow/warn/block per onUnknownUsage, never as zero", () => {
      assert.equal(evaluateQuotaBudget(unknownQuotaUsage(), 4, "allow").status, "PASS");
      assert.equal(evaluateQuotaBudget(unknownQuotaUsage(), 4, "warn").status, "WARN");
      assert.equal(evaluateQuotaBudget(unknownQuotaUsage(), 4, "block").status, "BLOCK");
      assert.equal(evaluateQuotaBudget(unknownQuotaUsage(), 4, "block").findings[0]?.code, "QUOTA_UNKNOWN");
    });
  });
});

function emptySummary(): CodexSessionUsageSummary {
  return {
    totalTokenUsage: null,
    usedPercent: null,
    windowMinutes: null,
    resetsAt: null,
    secondaryUsedPercent: null,
    secondaryWindowMinutes: null,
    secondaryResetsAt: null,
    planType: null,
    sessionId: null,
    model: null,
    reasoningEffort: null,
    modelContextWindow: null
  };
}
