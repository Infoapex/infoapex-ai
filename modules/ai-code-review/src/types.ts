export type ReviewEngine = "fake" | "codex" | "claude";

export interface ReviewCriterion {
  readonly id: string;
  readonly description: string;
  readonly verify?: readonly string[];
  readonly paths?: readonly string[];
}

export interface ReviewRequest {
  readonly schemaVersion: "1.0";
  readonly runId: string;
  readonly reviewId: string;
  readonly baseCommit: string;
  readonly headCommit: string;
  readonly graphVersion?: number;
  readonly criteria: readonly ReviewCriterion[];
  readonly symbols?: readonly string[];
  readonly controlContext?: string;
}

export interface ReviewFinding {
  readonly id: string;
  readonly severity: "blocking" | "major" | "minor" | "note";
  readonly category: string;
  readonly files: readonly string[];
  readonly evidence: string;
  readonly criterionIds?: readonly string[];
}

export interface ReviewCoverage {
  readonly criterionId: string;
  readonly verdict: "supported" | "weak" | "missing" | "contradicted";
  readonly tests: readonly string[];
  readonly commands: readonly string[];
  readonly evidence: string;
}

export interface ReviewReport {
  readonly schemaVersion: "1.0";
  readonly runId: string;
  readonly reviewId: string;
  readonly status: "PASS" | "FAIL" | "BLOCKED";
  readonly planner: { readonly status: "PASS" | "SKIPPED" | "BLOCKED"; readonly draftPath?: string; readonly message?: string };
  readonly control: { readonly status: "PASS" | "SKIPPED" | "BLOCKED"; readonly health?: string; readonly brief?: string; readonly impact?: string; readonly message?: string };
  readonly worker: { readonly status: "PASS" | "FAIL" | "BLOCKED"; readonly engine?: string; readonly verdict?: "pass" | "fail"; readonly message?: string };
  readonly coverage: readonly ReviewCoverage[];
  readonly findings: readonly ReviewFinding[];
}

export interface ReviewConfig {
  readonly schemaVersion: "1.0";
  readonly planner: readonly string[];
  readonly worker: readonly string[];
  readonly control: readonly string[];
  readonly defaultEngine: ReviewEngine;
}

export interface CommandResult {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly error?: string;
}
