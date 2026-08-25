import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { runReadOnlyReview } from "../../src/review/review-command.js";

const fixtureRoot = join(process.cwd(), "tests", "fixtures", "review");

test("read-only review command validates and returns a fake review", () => {
  const result = runReadOnlyReview({
    repositoryPath: process.cwd(),
    inputPath: join(fixtureRoot, "request.json"),
    engine: "fake",
    fixturePath: join(fixtureRoot, "pass-no-findings.json")
  });

  assert.equal(result.status, "DONE");
  assert.equal(result.review?.verdict, "pass");
});

test("read-only review command fails closed without a fake fixture", () => {
  const result = runReadOnlyReview({
    repositoryPath: process.cwd(),
    inputPath: join(fixtureRoot, "request.json"),
    engine: "fake"
  });

  assert.equal(result.status, "BLOCKED");
  assert.match(result.message ?? "", /fixture/i);
});
