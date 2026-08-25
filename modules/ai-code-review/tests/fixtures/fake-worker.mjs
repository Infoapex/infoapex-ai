import { readFileSync } from "node:fs";
const args = process.argv.slice(2);
const inputPath = args[args.indexOf("--input") + 1];
const request = JSON.parse(readFileSync(inputPath, "utf8"));
console.log(JSON.stringify({
  status: "DONE",
  runId: request.runId,
  engine: "fake",
  review: {
    schemaVersion: "1.0",
    runId: request.runId,
    reviewId: request.reviewId,
    reviewer: "fake",
    graphVersion: request.graphVersion ?? 1,
    createdAt: "2026-01-01T00:00:00Z",
    verdict: "pass",
    criterionCoverage: request.criteria.map((criterion) => ({
      criterionId: criterion.id,
      verdict: "supported",
      tests: criterion.verify ?? [],
      commands: criterion.verify ?? [],
      evidence: "Fixture review evidence."
    })),
    findings: []
  }
}));
