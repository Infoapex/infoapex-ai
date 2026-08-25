import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { compileRepairTasks } from "../../src/repair/compile-repair-tasks.js";
import { ingestIndependentReview } from "../../src/review/ingest-review.js";
import { loadReviewFixture } from "../../src/review/review-fixture.js";
import { SchemaRegistry } from "../../src/schema/json-schema.js";

const registry = SchemaRegistry.load({ schemaDirectory: "schemas" });

function eligibleFinding(overrides: {
  readonly id: string;
  readonly criterionIds: readonly string[];
  readonly files: readonly string[];
  readonly recommendedScope?: readonly string[];
}) {
  return {
    id: overrides.id,
    severity: "blocking" as const,
    category: "correctness",
    criterionIds: overrides.criterionIds,
    files: overrides.files,
    evidence: `evidence for ${overrides.id}`,
    recommendedScope: overrides.recommendedScope,
    eligibleForRepair: true,
    ineligibilityReason: null
  };
}

describe("repair task compiler", () => {
  it("compiles one repair task per group of non-overlapping findings", () => {
    const result = compileRepairTasks({
      runId: "run-repair-compiler",
      graphVersion: 2,
      maximumAttempts: 3,
      now: "2026-08-14T12:00:00Z",
      registry,
      blockingFindings: [
        eligibleFinding({ id: "REV-001", criterionIds: ["AC-01"], files: ["a/one.ts"] }),
        eligibleFinding({ id: "REV-002", criterionIds: ["AC-02"], files: ["b/two.ts"] })
      ],
      criterionCoverage: [
        { criterionId: "AC-01", verdict: "contradicted", tests: [], commands: ["test-a"], evidence: "e" },
        { criterionId: "AC-02", verdict: "missing", tests: [], commands: ["test-b"], evidence: "e" }
      ]
    });

    assert.equal(result.skipped.length, 0);
    assert.equal(result.tasks.length, 2);
    assert.deepEqual(
      result.tasks.map((task) => task.sourceFindingIds),
      [["REV-001"], ["REV-002"]]
    );
  });

  it("merges findings that share a scope path into a single repair task", () => {
    const result = compileRepairTasks({
      runId: "run-repair-compiler",
      graphVersion: 2,
      maximumAttempts: 3,
      now: "2026-08-14T12:00:00Z",
      registry,
      blockingFindings: [
        eligibleFinding({ id: "REV-001", criterionIds: ["AC-01"], files: ["backend/Auth/Service.cs"] }),
        eligibleFinding({ id: "REV-002", criterionIds: ["AC-02"], files: ["backend/Auth/Service.cs"] })
      ],
      criterionCoverage: [
        { criterionId: "AC-01", verdict: "contradicted", tests: [], commands: ["backend-tests"], evidence: "e" },
        { criterionId: "AC-02", verdict: "missing", tests: [], commands: ["backend-tests"], evidence: "e" }
      ]
    });

    assert.equal(result.tasks.length, 1);
    assert.deepEqual(result.tasks[0]?.sourceFindingIds, ["REV-001", "REV-002"]);
    assert.deepEqual(result.tasks[0]?.allowedPaths, ["backend/Auth/Service.cs"]);
    assert.deepEqual(result.tasks[0]?.verify, ["backend-tests"]);
  });

  it("skips a group instead of emitting a repair task with no verification command", () => {
    const result = compileRepairTasks({
      runId: "run-repair-compiler",
      graphVersion: 2,
      maximumAttempts: 3,
      now: "2026-08-14T12:00:00Z",
      registry,
      blockingFindings: [eligibleFinding({ id: "REV-009", criterionIds: ["AC-99"], files: ["x/y.ts"] })],
      criterionCoverage: []
    });

    assert.equal(result.tasks.length, 0);
    assert.deepEqual(result.skipped, [{ findingIds: ["REV-009"], reason: "no-verification-commands" }]);
  });

  it("produces the same task id for the same finding set (deterministic compilation)", () => {
    const buildInput = () => ({
      runId: "run-repair-compiler",
      graphVersion: 2,
      maximumAttempts: 3,
      now: "2026-08-14T12:00:00Z",
      registry,
      blockingFindings: [eligibleFinding({ id: "REV-001", criterionIds: ["AC-01"], files: ["a/one.ts"] })],
      criterionCoverage: [
        { criterionId: "AC-01", verdict: "contradicted" as const, tests: [], commands: ["test-a"], evidence: "e" }
      ]
    });

    const first = compileRepairTasks(buildInput());
    const second = compileRepairTasks(buildInput());

    assert.equal(first.tasks[0]?.id, second.tasks[0]?.id);
  });

  it("compiles end to end from a fake review fixture through ingestion", () => {
    const review = loadReviewFixture("tests/fixtures/review/fail-with-blocking.json", registry);
    const ingestion = ingestIndependentReview(review);
    const result = compileRepairTasks({
      runId: review.runId,
      graphVersion: review.graphVersion + 1,
      maximumAttempts: 3,
      registry,
      blockingFindings: ingestion.blockingFindings,
      criterionCoverage: review.criterionCoverage
    });

    assert.equal(result.tasks.length, 1);
    assert.deepEqual(result.tasks[0]?.sourceFindingIds, ["REV-001"]);
    assert.deepEqual(result.tasks[0]?.allowedPaths, ["backend.tests/Auth/**", "backend/Auth/**"]);
    assert.deepEqual(registry.validate("repair-task.schema.json", result.tasks[0]), { valid: true, errors: [] });
  });
});
