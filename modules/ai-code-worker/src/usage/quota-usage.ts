/**
 * Quota-percent usage: the fraction of a provider's rolling rate-limit window a task
 * or run consumed, e.g. Claude's "%5h"/"%week" or Codex's `rate_limits.primary`/
 * `secondary`. Deliberately separate from `EngineUsage`/`UsageTotals` (tokens, cost):
 * a quota percentage is a point-in-time gauge reading, not an additive amount, so it
 * must never be summed across tasks the way token counts are - the correct run-level
 * value is the LAST observed reading, not a total.
 *
 * Two sources exist and must never be conflated:
 * - `measured`: read directly from the provider (Codex's rollout `rate_limits`,
 *   confirmed present on real CLI 0.147.0 - see read-codex-session.ts).
 * - `estimated`: derived from a real token count via a calibrated tokens-per-point
 *   ratio (Claude has no local %5h/%week reading anywhere - see claude-calibration.ts).
 *
 * Both accounts here are flat-rate ($20/month) subscriptions, not pay-per-token API
 * billing, so this - not `costUsd` - is the metric that actually reflects what a task
 * costs the person running it: how much of their rolling quota it used.
 */

import type { CodexSessionUsageSummary } from "../benchmark/read-codex-session.js";

export type QuotaUsageSource = "measured" | "estimated";

export interface QuotaWindowUsage {
  readonly percent: number | null;
  readonly windowMinutes: number | null;
  readonly source: QuotaUsageSource | null;
}

export interface QuotaUsage {
  /** The short rolling window - Claude's "%5h", Codex's `rate_limits.primary`
   *  (`window_minutes: 300`). This is the window that actually throttles a busy
   *  session, so it is the one `economicVerdict` is judged on. */
  readonly fiveHour: QuotaWindowUsage;
  /** The long rolling window - Claude's "%week", Codex's `rate_limits.secondary`
   *  (`window_minutes: 10080`). Tracked for visibility, not gating. */
  readonly weekly: QuotaWindowUsage;
}

export function unknownQuotaWindow(): QuotaWindowUsage {
  return { percent: null, windowMinutes: null, source: null };
}

export function unknownQuotaUsage(): QuotaUsage {
  return { fiveHour: unknownQuotaWindow(), weekly: unknownQuotaWindow() };
}

/** Real, provider-measured quota from a Codex session summary (see
 *  read-codex-session.ts). `null` in, `unknownQuotaUsage()` out - the caller could not
 *  find or parse a rollout file, which is a normal, expected outcome (e.g. `exec --json`
 *  omitted usage AND no local rollout was found either), not an error. */
export function codexQuotaUsage(summary: CodexSessionUsageSummary | null): QuotaUsage {
  if (!summary) {
    return unknownQuotaUsage();
  }
  return {
    fiveHour: { percent: summary.usedPercent, windowMinutes: summary.windowMinutes, source: summary.usedPercent === null ? null : "measured" },
    weekly: {
      percent: summary.secondaryUsedPercent,
      windowMinutes: summary.secondaryWindowMinutes,
      source: summary.secondaryUsedPercent === null ? null : "measured"
    }
  };
}

/** Calibrated Claude estimate from a real, already-known total-token count for a
 *  completed task/run - reuses the same tokens-per-%5h-point ratio the pre-run
 *  planner uses (claude-calibration.ts), but applied post-hoc to a real total instead
 *  of a historical estimate. Always `estimated`, never `measured` - Claude has no
 *  local %5h/%week reading anywhere (confirmed, see docs/BENCHMARKS.md). */
export function claudeQuotaUsageFromTokens(totalTokens: number | null, tokensPerPercentPoint: number): QuotaUsage {
  if (totalTokens === null) {
    return unknownQuotaUsage();
  }
  return {
    fiveHour: { percent: totalTokens / tokensPerPercentPoint, windowMinutes: 300, source: "estimated" },
    weekly: unknownQuotaWindow()
  };
}

/** A run/task is economically comparable when we know what fraction of the 5-hour
 *  quota it used - measured or estimated both count, unlike `costUsd`, which for a
 *  subscription account frequently does not exist at all (see docs/RELEASE-GATES.md,
 *  P2-B). */
export function quotaEconomicVerdict(quota: QuotaUsage | null): "comparable" | "inconclusive" {
  return quota !== null && quota.fiveHour.percent !== null ? "comparable" : "inconclusive";
}

export interface QuotaBudgetFinding {
  readonly severity: "warning" | "blocker";
  readonly code: "QUOTA_UNKNOWN" | "QUOTA_BUDGET_EXCEEDED";
  readonly message: string;
}

export interface QuotaBudgetEvaluation {
  readonly status: "PASS" | "WARN" | "BLOCK";
  readonly findings: readonly QuotaBudgetFinding[];
}

/**
 * Evaluated post-hoc, after a run's real quota reading is known - unlike the token/
 * cost budgets in usage-budget.ts, this is NOT wired into the mid-run per-task loop
 * (that would require threading a live quota reading through every exit path of
 * three ~1000-line run state machines for a reading that is only ever discoverable
 * after an invocation completes, i.e. it could never actually prevent the run that
 * exceeded it - only the next one). It surfaces as a finding on the run report so a
 * threshold violation is visible and can inform the next run's budget, exactly like
 * `docs/BENCHMARKS.md`'s manual calibration loop already does by hand.
 */
export function evaluateQuotaBudget(
  quota: QuotaUsage | null,
  maximumRunFiveHourPercent: number | null,
  onUnknownUsage: "allow" | "warn" | "block" = "allow"
): QuotaBudgetEvaluation {
  if (maximumRunFiveHourPercent === null) {
    return { status: "PASS", findings: [] };
  }

  const percent = quota?.fiveHour.percent ?? null;

  if (percent === null) {
    if (onUnknownUsage === "block") {
      return {
        status: "BLOCK",
        findings: [{ severity: "blocker", code: "QUOTA_UNKNOWN", message: "5-hour quota percent is unknown and policy is block." }]
      };
    }
    if (onUnknownUsage === "warn") {
      return {
        status: "WARN",
        findings: [{ severity: "warning", code: "QUOTA_UNKNOWN", message: "5-hour quota percent is unknown." }]
      };
    }
    return { status: "PASS", findings: [] };
  }

  if (percent > maximumRunFiveHourPercent) {
    return {
      status: "BLOCK",
      findings: [
        {
          severity: "blocker",
          code: "QUOTA_BUDGET_EXCEEDED",
          message: `5-hour quota percent ${percent} exceeds maximum ${maximumRunFiveHourPercent}.`
        }
      ]
    };
  }

  return { status: "PASS", findings: [] };
}
