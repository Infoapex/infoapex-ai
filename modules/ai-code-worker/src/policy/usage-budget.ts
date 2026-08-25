import type { EngineUsage } from "../engines/engine-event.js";

export interface UsageBudget {
  readonly maximumAgentInvocations: number;
  readonly maximumRunInputUncachedTokens: number;
  readonly maximumRunCacheReadTokens: number;
  readonly maximumRunCacheWriteTokens: number;
  readonly maximumRunOutputTokens: number;
  readonly maximumRunCostUsd: number | null;
  readonly onUnknownUsage: "allow" | "warn" | "block" | "block-if-cost-required";
}

export interface UsageTotals {
  readonly agentInvocations: number;
  readonly inputUncachedTokens: number | null;
  readonly cacheReadTokens: number | null;
  readonly cacheWriteTokens: number | null;
  readonly outputTokens: number | null;
  readonly costUsd: number | null;
}

export interface UsageBudgetEvaluation {
  readonly status: "PASS" | "WARN" | "BLOCK";
  readonly findings: readonly UsageBudgetFinding[];
}

export interface UsageBudgetFinding {
  readonly severity: "warning" | "blocker";
  readonly code: "USAGE_UNKNOWN" | "USAGE_BUDGET_EXCEEDED";
  readonly field: keyof UsageTotals;
  readonly message: string;
}

export const emptyUsageTotals: UsageTotals = {
  agentInvocations: 0,
  inputUncachedTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  outputTokens: 0,
  costUsd: null
};

export function addUsage(totals: UsageTotals, usage: EngineUsage): UsageTotals {
  return {
    agentInvocations: totals.agentInvocations + 1,
    inputUncachedTokens: addNullable(totals.inputUncachedTokens, usage.inputUncachedTokens),
    cacheReadTokens: addNullable(totals.cacheReadTokens, usage.cacheReadTokens),
    cacheWriteTokens: addNullable(totals.cacheWriteTokens, usage.cacheWriteTokens),
    outputTokens: addNullable(totals.outputTokens, usage.outputTokens),
    costUsd: addNullable(totals.costUsd, usage.costUsd)
  };
}

export function evaluateUsageBudget(totals: UsageTotals, budget: UsageBudget): UsageBudgetEvaluation {
  const findings: UsageBudgetFinding[] = [];

  checkMaximum(findings, "agentInvocations", totals.agentInvocations, budget.maximumAgentInvocations);
  checkMaximum(findings, "inputUncachedTokens", totals.inputUncachedTokens, budget.maximumRunInputUncachedTokens, budget.onUnknownUsage);
  checkMaximum(findings, "cacheReadTokens", totals.cacheReadTokens, budget.maximumRunCacheReadTokens, budget.onUnknownUsage);
  checkMaximum(findings, "cacheWriteTokens", totals.cacheWriteTokens, budget.maximumRunCacheWriteTokens, budget.onUnknownUsage);
  checkMaximum(findings, "outputTokens", totals.outputTokens, budget.maximumRunOutputTokens, budget.onUnknownUsage);

  if (budget.maximumRunCostUsd !== null) {
    checkMaximum(findings, "costUsd", totals.costUsd, budget.maximumRunCostUsd, budget.onUnknownUsage);
  }

  return {
    status: findings.some((finding) => finding.severity === "blocker")
      ? "BLOCK"
      : findings.length > 0
        ? "WARN"
        : "PASS",
    findings
  };
}

export function budgetFromManifest(value: unknown): UsageBudget {
  const budget = value as Record<string, unknown>;

  return {
    maximumAgentInvocations: Number(budget.maximumAgentInvocations),
    maximumRunInputUncachedTokens: Number(budget.maximumRunInputUncachedTokens),
    maximumRunCacheReadTokens: Number(budget.maximumRunCacheReadTokens),
    maximumRunCacheWriteTokens: Number(budget.maximumRunCacheWriteTokens),
    maximumRunOutputTokens: Number(budget.maximumRunOutputTokens),
    maximumRunCostUsd: typeof budget.maximumRunCostUsd === "number" ? budget.maximumRunCostUsd : null,
    onUnknownUsage: budget.onUnknownUsage as UsageBudget["onUnknownUsage"]
  };
}

function checkMaximum(
  findings: UsageBudgetFinding[],
  field: keyof UsageTotals,
  value: number | null,
  maximum: number,
  onUnknownUsage: UsageBudget["onUnknownUsage"] = "block"
): void {
  if (value === null) {
    if (onUnknownUsage === "block" || onUnknownUsage === "block-if-cost-required") {
      findings.push({
        severity: "blocker",
        code: "USAGE_UNKNOWN",
        field,
        message: `${field} is unknown and policy is ${onUnknownUsage}.`
      });
    } else if (onUnknownUsage === "warn") {
      findings.push({
        severity: "warning",
        code: "USAGE_UNKNOWN",
        field,
        message: `${field} is unknown.`
      });
    }
    return;
  }

  if (value > maximum) {
    findings.push({
      severity: "blocker",
      code: "USAGE_BUDGET_EXCEEDED",
      field,
      message: `${field} ${value} exceeds maximum ${maximum}.`
    });
  }
}

function addNullable(left: number | null, right: number | null): number | null {
  if (left === null || right === null) {
    return null;
  }

  return left + right;
}
