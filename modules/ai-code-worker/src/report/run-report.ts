import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { CompileReport } from "../compile/compile.js";
import type { QualityGateResult } from "../runner/quality-gate.js";
import type { UsageTotals } from "../policy/usage-budget.js";
import type { CodexSandboxDecision } from "../policy/codex-sandbox-policy.js";
import { loadExecutionProfile } from "../compile/compile.js";
import {
  resolveExecutionBackend,
  type EnvironmentCapabilityReport,
  type TrustedLocalAuthorizationRecord
} from "../execution/environment.js";
import { SchemaRegistry } from "../schema/json-schema.js";

export interface WriteRunReportInput {
  readonly compile: CompileReport;
  readonly status: "DONE" | "BLOCKED";
  readonly engine: "fake" | "codex" | "claude";
  readonly taskCommits: Readonly<Record<string, string>>;
  readonly gateResults: readonly QualityGateResult[];
  readonly usageTotals: UsageTotals | null;
  readonly blockedReason?: string | null;
}

export interface RunReport {
  readonly schemaVersion: "1.0";
  readonly runId: string;
  readonly status: "DONE" | "BLOCKED";
  readonly plan: string | null;
  readonly baseCommit: string | null;
  readonly engine: "fake" | "codex" | "claude";
  readonly sandbox: CodexSandboxDecision | null;
  readonly executionEnvironment: {
    readonly capabilityReport: EnvironmentCapabilityReport;
    readonly trustedLocalAuthorization: TrustedLocalAuthorizationRecord | null;
  } | null;
  readonly taskCommits: Readonly<Record<string, string>>;
  readonly gates: readonly RunReportGate[];
  readonly usage: UsageTotals | null;
  readonly review: {
    readonly status: string | null;
    readonly coverageRows: number | null;
    readonly findings: number | null;
    readonly path: string | null;
  };
  readonly artifacts: {
    readonly runEvidencePath: string | null;
    readonly reviewPath: string | null;
    readonly sandboxPolicyPath: string | null;
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
  const sandboxPolicyPath = join(runRoot, "sandbox-policy.json");
  const sandbox = readSandboxDecision(sandboxPolicyPath);
  const executionEnvironment = readExecutionEnvironmentEvidence(input.compile);
  const report: RunReport = {
    schemaVersion: "1.0",
    runId: input.compile.runId,
    status: input.status,
    plan: readString(manifest?.plan?.path),
    baseCommit: readString(manifest?.base?.commit),
    engine: input.engine,
    sandbox,
    executionEnvironment,
    taskCommits: input.taskCommits,
    gates: input.gateResults.map((gate) => ({
      id: gate.id,
      exitCode: gate.exitCode,
      failureClass: gate.failureClass,
      durationMs: gate.durationMs,
      outputSha256: gate.outputSha256
    })),
    usage: input.usageTotals,
    review: {
      status: readString(review?.status),
      coverageRows: Array.isArray(review?.coverageMatrix) ? review.coverageMatrix.length : null,
      findings: Array.isArray(review?.findings) ? review.findings.length : null,
      path: existsSync(reviewPath) ? reviewPath : null
    },
    artifacts: {
      runEvidencePath: existsSync(runEvidencePath) ? runEvidencePath : null,
      reviewPath: existsSync(reviewPath) ? reviewPath : null,
      sandboxPolicyPath: existsSync(sandboxPolicyPath) ? sandboxPolicyPath : null
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
  const environmentWarnings = report.executionEnvironment?.capabilityReport.warnings.length
    ? report.executionEnvironment.capabilityReport.warnings.map((warning) => `- ${warning}`).join("\n")
    : "- No execution-environment warnings recorded.";

  return `# ai-code-worker Run Report

- Run ID: ${report.runId}
- Plan: ${report.plan ?? "null"}
- Base commit: ${report.baseCommit ?? "null"}
- Engine: ${report.engine}
- Sandbox: ${report.sandbox?.mode ?? "not-applicable"} (${report.sandbox?.status ?? "not-applicable"})
- Sandbox authorization source: ${report.sandbox?.authorization?.source ?? "null"}
- Sandbox authorized by: ${report.sandbox?.authorization?.authorizedBy ?? "null"}
- Sandbox authorization reason: ${report.sandbox?.authorization?.reason ?? "null"}
- Execution backend: ${report.executionEnvironment?.capabilityReport.backend ?? "not-recorded"}
- Execution profile: ${report.executionEnvironment?.capabilityReport.profileId ?? "not-recorded"} (${report.executionEnvironment?.capabilityReport.kind ?? "not-recorded"})
- Security boundary: ${report.executionEnvironment?.capabilityReport.securityBoundary ?? "not-recorded"}
- Trusted-local authorized by: ${report.executionEnvironment?.trustedLocalAuthorization?.authorizedBy ?? "null"}
- Trusted-local authorization source: ${report.executionEnvironment?.trustedLocalAuthorization?.source ?? "null"}
- Status: ${report.status}
- Blocked reason: ${report.blockedReason ?? "null"}

## Execution Environment Warnings

${environmentWarnings}

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
`;
}

function readExecutionEnvironmentEvidence(
  compile: CompileReport
): RunReport["executionEnvironment"] {
  if (!compile.repository.ok || !compile.authorization) return null;
  try {
    const profile = loadExecutionProfile(compile.repository.worktreeRoot);
    const capabilityReport = resolveExecutionBackend(profile).probe(profile);
    const expected = compile.authorization.executionEnvironment;
    if (
      capabilityReport.profileId !== expected.profileId ||
      capabilityReport.kind !== expected.kind ||
      capabilityReport.profileSha256 !== expected.profileSha256
    ) {
      return null;
    }
    return {
      capabilityReport,
      trustedLocalAuthorization: compile.authorization.trustedLocalAuthorization ?? null
    };
  } catch {
    return null;
  }
}

function readJson(path: string | null): any {
  if (!path || !existsSync(path)) {
    return null;
  }

  return JSON.parse(readFileSync(path, "utf8"));
}

function readSandboxDecision(path: string): CodexSandboxDecision | null {
  if (!existsSync(path)) return null;
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as unknown;
    SchemaRegistry.load().assertValid("codex-sandbox-policy.schema.json", value);
    return value as CodexSandboxDecision;
  } catch {
    // The run coordinator reports the immutable-state conflict. The report
    // generator must not echo or trust malformed policy content.
    return null;
  }
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}
