import { SchemaRegistry } from "../schema/json-schema.js";

export interface CoverageReviewTask {
  readonly id: string;
  readonly acceptanceCriteria: readonly string[];
  readonly verify: readonly string[];
}

export interface BuildCoverageReviewInput {
  readonly runId: string;
  readonly reviewer: string;
  readonly tasks: readonly CoverageReviewTask[];
  readonly evidenceByTask: Readonly<Record<string, string>>;
  readonly registry?: SchemaRegistry;
}

export interface ReviewResult {
  readonly schemaVersion: "1.0";
  readonly runId: string;
  readonly reviewer: string;
  readonly status: "PASS" | "FAIL" | "REVIEW_REQUIRED";
  readonly coverageMatrix: readonly CoverageMatrixEntry[];
  readonly findings: readonly ReviewFinding[];
}

export interface CoverageMatrixEntry {
  readonly criterion: string;
  readonly test: string;
  readonly command: string;
  readonly evidence: string;
}

export interface ReviewFinding {
  readonly severity: "blocker" | "major" | "minor" | "note";
  readonly message: string;
}

export function buildCoverageReview(input: BuildCoverageReviewInput): ReviewResult {
  const findings: ReviewFinding[] = [];
  const coverageMatrix: CoverageMatrixEntry[] = [];

  for (const task of input.tasks) {
    const evidence = input.evidenceByTask[task.id];
    const command = task.verify[0];

    for (const criterion of task.acceptanceCriteria) {
      if (!command) {
        findings.push({
          severity: "blocker",
          message: `Task ${task.id} criterion has no verification command: ${criterion}`
        });
        continue;
      }

      if (!evidence) {
        findings.push({
          severity: "blocker",
          message: `Task ${task.id} criterion has no evidence artifact: ${criterion}`
        });
        continue;
      }

      coverageMatrix.push({
        criterion,
        test: `task:${task.id}`,
        command,
        evidence
      });
    }
  }

  const status = findings.some((finding) => finding.severity === "blocker")
    ? "FAIL"
    : findings.some((finding) => finding.severity === "major")
      ? "REVIEW_REQUIRED"
      : "PASS";
  const review: ReviewResult = {
    schemaVersion: "1.0",
    runId: input.runId,
    reviewer: input.reviewer,
    status,
    coverageMatrix,
    findings
  };

  (input.registry ?? SchemaRegistry.load()).assertValid("review.schema.json", review);
  return review;
}
