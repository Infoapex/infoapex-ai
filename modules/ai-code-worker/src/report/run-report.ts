import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { CompileReport } from "../compile/compile.js";
import type { QualityGateResult } from "../runner/quality-gate.js";
import { budgetFromManifest, type UsageTotals } from "../policy/usage-budget.js";
import { assessUsageTotals, type UsageAssessment } from "../usage/normalized-usage.js";
import { claudeQuotaUsageFromTokens, codexQuotaUsage, evaluateQuotaBudget, unknownQuotaUsage, type QuotaBudgetEvaluation, type QuotaUsage } from "../usage/quota-usage.js";
import { fitTokensPerPercentPoint } from "../benchmark/claude-calibration.js";
import { findLatestCodexRolloutPath, readCodexSessionLog } from "../benchmark/read-codex-session.js";

/**
 * Real-quota lookup is best-effort and read-only, mirroring the same pattern already
 * proven in validation/p2-a and p2-b's live pilots: the most-recently-modified local
 * Codex rollout file, at the point this run's report is written, is this run's own
 * session in every realistic single-worker scenario (parallel unrelated Codex
 * sessions on the same machine are the one case this could misattribute - accepted,
 * same trade-off the P2 pilots already made).
 */
function resolveQuotaUsage(engine: "fake" | "codex" | "claude", usageTotals: UsageTotals | null, codexSessionsDir?: string): QuotaUsage {
  if (engine === "codex") {
    const path = findLatestCodexRolloutPath(codexSessionsDir ? { codexSessionsDir } : {});
    return codexQuotaUsage(path ? readCodexSessionLog(path) : null);
  }
  if (engine === "claude") {
    const total = totalReportedTokens(usageTotals);
    return claudeQuotaUsageFromTokens(total, fitTokensPerPercentPoint());
  }
  return unknownQuotaUsage();
}

function totalReportedTokens(totals: UsageTotals | null): number | null {
  if (!totals) {
    return null;
  }
  const { inputUncachedTokens, cacheReadTokens, cacheWriteTokens, outputTokens } = totals;
  if (inputUncachedTokens === null && cacheReadTokens === null && cacheWriteTokens === null && outputTokens === null) {
    return null;
  }
  return (inputUncachedTokens ?? 0) + (cacheReadTokens ?? 0) + (cacheWriteTokens ?? 0) + (outputTokens ?? 0);
}

export interface WriteRunReportInput {
  readonly compile: CompileReport;
  readonly status: "DONE" | "BLOCKED";
  readonly engine: "fake" | "codex" | "claude";
  readonly taskCommits: Readonly<Record<string, string>>;
  readonly gateResults: readonly QualityGateResult[];
  readonly usageTotals: UsageTotals | null;
  readonly blockedReason?: string | null;
  /** Test-only override, forwarded from CodexRunOptions.codexSessionsDir - see that
   *  field's doc comment. */
  readonly codexSessionsDir?: string;
}

export interface RunReport {
  readonly schemaVersion: "1.0";
  readonly runId: string;
  readonly status: "DONE" | "BLOCKED";
  readonly plan: string | null;
  readonly baseCommit: string | null;
  readonly engine: "fake" | "codex" | "claude";
  readonly taskCommits: Readonly<Record<string, string>>;
  readonly gates: readonly RunReportGate[];
  readonly usage: UsageTotals | null;
  readonly usageAssessment: UsageAssessment;
  readonly quotaUsage: QuotaUsage;
  readonly quotaBudgetEvaluation: QuotaBudgetEvaluation;
  readonly review: {
    readonly status: string | null;
    readonly coverageRows: number | null;
    readonly findings: number | null;
    readonly path: string | null;
  };
  readonly artifacts: {
    readonly runEvidencePath: string | null;
    readonly reviewPath: string | null;
  };
  readonly blockedReason: string | null;
}

export interface RunReportGate {
  readonly id: string;
  readonly exitCode: number | null;
  readonly failureClass: string | null;
  readonly durationMs: number;
  readonly outputSha256: string;
}

export function writeRunReports(input: WriteRunReportInput): { readonly jsonPath: string; readonly markdownPath: string } | null {
  if (!input.compile.runId || !input.compile.state.runRoot) {
    return null;
  }

  const runRoot = input.compile.state.runRoot;
  const manifest = readJson(input.compile.state.manifestPath);
  const reviewPath = join(runRoot, "review.json");
  const review = readJson(reviewPath);
  const runEvidencePath = join(runRoot, "run-evidence.json");
  const quotaUsage = resolveQuotaUsage(input.engine, input.usageTotals, input.codexSessionsDir);
  const maximumRunFiveHourPercent = manifest?.budgets ? budgetFromManifest(manifest.budgets).maximumRunFiveHourPercent : null;
  const report: RunReport = {
    schemaVersion: "1.0",
    runId: input.compile.runId,
    status: input.status,
    plan: readString(manifest?.plan?.path),
    baseCommit: readString(manifest?.base?.commit),
    engine: input.engine,
    taskCommits: input.taskCommits,
    gates: input.gateResults.map((gate) => ({
      id: gate.id,
      exitCode: gate.exitCode,
      failureClass: gate.failureClass,
      durationMs: gate.durationMs,
      outputSha256: gate.outputSha256
    })),
    usage: input.usageTotals,
    usageAssessment: assessUsageTotals(input.usageTotals, quotaUsage),
    quotaUsage,
    quotaBudgetEvaluation: evaluateQuotaBudget(quotaUsage, maximumRunFiveHourPercent),
    review: {
      status: readString(review?.status),
      coverageRows: Array.isArray(review?.coverageMatrix) ? review.coverageMatrix.length : null,
      findings: Array.isArray(review?.findings) ? review.findings.length : null,
      path: existsSync(reviewPath) ? reviewPath : null
    },
    artifacts: {
      runEvidencePath: existsSync(runEvidencePath) ? runEvidencePath : null,
      reviewPath: existsSync(reviewPath) ? reviewPath : null
    },
    blockedReason: input.blockedReason ?? null
  };
  const jsonPath = join(runRoot, "run-report.json");
  const markdownPath = join(runRoot, "run-report.md");

  writeFileSync(jsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  writeFileSync(markdownPath, renderRunReportMarkdown(report), "utf8");

  return { jsonPath, markdownPath };
}

export function renderRunReportMarkdown(report: RunReport): string {
  const coverage = report.review.coverageRows === null ? "unknown" : String(report.review.coverageRows);
  const findings = report.review.findings === null ? "unknown" : String(report.review.findings);
  const gates = report.gates.length === 0
    ? "- No gates recorded."
    : report.gates
        .map((gate) => `- ${gate.id}: exit=${gate.exitCode ?? "null"}, failure=${gate.failureClass ?? "none"}`)
        .join("\n");
  const commits = Object.keys(report.taskCommits).length === 0
    ? "- No task commits recorded."
    : Object.entries(report.taskCommits)
        .map(([taskId, commit]) => `- ${taskId}: ${commit}`)
        .join("\n");

  return `# ai-code-worker Run Report

- Run ID: ${report.runId}
- Plan: ${report.plan ?? "null"}
- Base commit: ${report.baseCommit ?? "null"}
- Engine: ${report.engine}
- Status: ${report.status}
- Blocked reason: ${report.blockedReason ?? "null"}

## Task Commits

${commits}

## Gates

${gates}

## Review

- Status: ${report.review.status ?? "null"}
- Coverage rows: ${coverage}
- Findings: ${findings}
- Review artifact: ${report.review.path ?? "null"}

## Usage

| Metric | Value |
|---|---:|
| Agent invocations | ${report.usage?.agentInvocations ?? "null"} |
| Input uncached tokens | ${report.usage?.inputUncachedTokens ?? "null"} |
| Cache read tokens | ${report.usage?.cacheReadTokens ?? "null"} |
| Cache write tokens | ${report.usage?.cacheWriteTokens ?? "null"} |
| Output tokens | ${report.usage?.outputTokens ?? "null"} |
| Reported cost USD | ${report.usage?.costUsd ?? "null"} |

- Completeness: ${report.usageAssessment.completeness}
- Economic verdict: ${report.usageAssessment.economicVerdict}
- Unknown fields: ${report.usageAssessment.unknownFields.join(", ") || "none"}

## Quota (5-hour / weekly window)

Both Codex and Claude are used here on flat-rate ($20/mo) subscriptions, not
pay-per-token API billing - this is the metric that reflects real cost, not \`costUsd\`.

| Window | Percent | Source |
|---|---:|---|
| 5-hour | ${report.quotaUsage.fiveHour.percent ?? "null"} | ${report.quotaUsage.fiveHour.source ?? "unknown"} |
| Weekly | ${report.quotaUsage.weekly.percent ?? "null"} | ${report.quotaUsage.weekly.source ?? "unknown"} |

- Quota budget: ${report.quotaBudgetEvaluation.status}${
    report.quotaBudgetEvaluation.findings.length > 0
      ? ` (${report.quotaBudgetEvaluation.findings.map((finding) => finding.message).join("; ")})`
      : ""
  }
`;
}

function readJson(path: string | null): any {
  if (!path || !existsSync(path)) {
    return null;
  }

  return JSON.parse(readFileSync(path, "utf8"));
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}
