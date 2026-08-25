export type IndependentReviewFindingSeverity = "blocking" | "major" | "minor" | "note";

export interface IndependentReviewFinding {
  readonly id: string;
  readonly severity: IndependentReviewFindingSeverity;
  readonly category: string;
  readonly criterionIds: readonly string[];
  readonly files: readonly string[];
  readonly evidence: string;
  readonly recommendedScope?: readonly string[];
}

export type CriterionCoverageVerdict = "supported" | "weak" | "missing" | "contradicted";

export interface CriterionCoverageEntry {
  readonly criterionId: string;
  readonly verdict: CriterionCoverageVerdict;
  readonly tests: readonly string[];
  readonly commands: readonly string[];
  readonly evidence: string;
}

export interface IndependentReviewResult {
  readonly schemaVersion: "1.0";
  readonly runId: string;
  readonly reviewId: string;
  readonly reviewer: string;
  readonly graphVersion: number;
  readonly createdAt: string;
  readonly verdict: "pass" | "fail";
  readonly criterionCoverage: readonly CriterionCoverageEntry[];
  readonly findings: readonly IndependentReviewFinding[];
}
