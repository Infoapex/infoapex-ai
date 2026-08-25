import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ingestIndependentReview } from "../../src/review/ingest-review.js";
import { loadReviewFixture } from "../../src/review/review-fixture.js";
import { SchemaRegistry, SchemaValidationError } from "../../src/schema/json-schema.js";

const registry = SchemaRegistry.load({ schemaDirectory: "schemas" });

describe("review fixture loading", () => {
  it("loads and validates a passing fixture with no findings", () => {
    const review = loadReviewFixture("tests/fixtures/review/pass-no-findings.json", registry);

    assert.equal(review.verdict, "pass");
    assert.equal(review.findings.length, 0);
  });

  it("rejects a fixture missing the required verdict field", () => {
    assert.throws(
      () => loadReviewFixture("tests/fixtures/review/invalid-missing-verdict.json", registry),
      SchemaValidationError
    );
  });
});

describe("review finding ingestion", () => {
  it("marks a blocking finding with a file and criterion as eligible for repair", () => {
    const review = loadReviewFixture("tests/fixtures/review/fail-with-blocking.json", registry);
    const result = ingestIndependentReview(review);

    assert.equal(result.findings.length, 2);
    assert.deepEqual(
      result.blockingFindings.map((finding) => finding.id),
      ["REV-001"]
    );

    const note = result.findings.find((finding) => finding.id === "REV-002");
    assert.equal(note?.eligibleForRepair, false);
    assert.equal(note?.ineligibilityReason, "not-blocking");
  });

  it("does not treat a blocking finding without files or criteria as repair-eligible", () => {
    const review = loadReviewFixture("tests/fixtures/review/fail-with-ineligible-blocking.json", registry);
    const result = ingestIndependentReview(review);

    assert.equal(result.blockingFindings.length, 0);
    assert.equal(result.findings[0]?.eligibleForRepair, false);
    assert.equal(result.findings[0]?.ineligibilityReason, "missing-files");
  });

  it("deduplicates findings that share the same id, keeping the first occurrence", () => {
    const review = loadReviewFixture("tests/fixtures/review/fail-with-duplicate-ids.json", registry);
    const result = ingestIndependentReview(review);

    assert.equal(result.findings.length, 1);
    assert.deepEqual(result.duplicateFindingIds, ["REV-001"]);
    assert.match(result.findings[0]?.evidence ?? "", /Concurrent refresh accepts the same token twice\./);
  });
});
