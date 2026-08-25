import type { IndependentReviewFinding, IndependentReviewResult } from "./independent-review.js";

export type FindingIneligibilityReason = "not-blocking" | "missing-files" | "missing-criterion-ids";

export interface IngestedFinding extends IndependentReviewFinding {
  readonly eligibleForRepair: boolean;
  readonly ineligibilityReason: FindingIneligibilityReason | null;
}

export interface ReviewIngestionResult {
  readonly review: IndependentReviewResult;
  readonly findings: readonly IngestedFinding[];
  readonly blockingFindings: readonly IngestedFinding[];
  readonly duplicateFindingIds: readonly string[];
}

/**
 * Deterministic ingestion of an independent review result: no model judgment is
 * consulted here, only the structural rule from IMPLEMENTATION-PLAN.md §9.3 -
 * "a finding with no file, reproducible behavior, or affected criterion cannot
 * automatically generate a blocking repair task."
 */
export function ingestIndependentReview(review: IndependentReviewResult): ReviewIngestionResult {
  const seenIds = new Set<string>();
  const duplicateFindingIds: string[] = [];
  const findings: IngestedFinding[] = [];

  for (const finding of review.findings) {
    if (seenIds.has(finding.id)) {
      duplicateFindingIds.push(finding.id);
      continue;
    }

    seenIds.add(finding.id);
    findings.push({
      ...finding,
      eligibleForRepair: isEligibleForRepair(finding),
      ineligibilityReason: ineligibilityReason(finding)
    });
  }

  return {
    review,
    findings,
    blockingFindings: findings.filter((finding) => finding.eligibleForRepair),
    duplicateFindingIds
  };
}

function isEligibleForRepair(finding: IndependentReviewFinding): boolean {
  return finding.severity === "blocking" && finding.files.length > 0 && finding.criterionIds.length > 0;
}

function ineligibilityReason(finding: IndependentReviewFinding): FindingIneligibilityReason | null {
  if (finding.severity !== "blocking") {
    return "not-blocking";
  }

  if (finding.files.length === 0) {
    return "missing-files";
  }

  if (finding.criterionIds.length === 0) {
    return "missing-criterion-ids";
  }

  return null;
}
