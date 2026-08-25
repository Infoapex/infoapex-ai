import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildCoverageReview } from "../../src/review/coverage-review.js";
import { SchemaRegistry } from "../../src/schema/json-schema.js";

const registry = SchemaRegistry.load({ schemaDirectory: "schemas" });

describe("coverage review", () => {
  it("passes when every acceptance criterion has command and evidence", () => {
    const review = buildCoverageReview({
      runId: "run-review",
      reviewer: "deterministic-read-only",
      tasks: [
        {
          id: "TASK-01",
          acceptanceCriteria: ["Criterion A", "Criterion B"],
          verify: ["node -e \"process.exit(0)\""]
        }
      ],
      evidenceByTask: {
        "TASK-01": "tasks/TASK-01/evidence.json"
      },
      registry
    });

    assert.equal(review.status, "PASS");
    assert.equal(review.coverageMatrix.length, 2);
    assert.deepEqual(registry.validate("review.schema.json", review), { valid: true, errors: [] });
  });

  it("fails when a criterion has no verification command", () => {
    const review = buildCoverageReview({
      runId: "run-review",
      reviewer: "deterministic-read-only",
      tasks: [
        {
          id: "TASK-01",
          acceptanceCriteria: ["Criterion A"],
          verify: []
        }
      ],
      evidenceByTask: {
        "TASK-01": "tasks/TASK-01/evidence.json"
      },
      registry
    });

    assert.equal(review.status, "FAIL");
    assert.equal(review.findings[0]?.severity, "blocker");
    assert.match(review.findings[0]?.message ?? "", /no verification command/);
  });
});
