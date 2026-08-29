import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { SchemaRegistry } from "../../src/schema/json-schema.js";

const registry = SchemaRegistry.load({ schemaDirectory: "schemas" });

describe("schema registry", () => {
  const validExamples = [
    ["project-config.schema.json", "templates/project/.ai-code-worker/config.json"],
    ["quality-gates.schema.json", "templates/project/.ai-code-worker/quality-gates.json"],
    ["execution-environment.schema.json", "templates/project/.ai-code-worker/execution-environment.example.json"],
    ["pilot-baseline.schema.json", "templates/project/.ai-code-worker/pilot-baseline.example.json"],
    ["event.schema.json", "templates/reports/event.example.json"],
    ["run-intent.schema.json", "templates/reports/run-intent.example.json"],
    ["run-authorization.schema.json", "templates/reports/run-authorization.example.json"],
    ["task-input-snapshot.schema.json", "templates/reports/task-input.example.json"],
    ["engine-event.schema.json", "templates/reports/engine-event.example.json"],
    ["evidence.schema.json", "templates/reports/evidence.example.json"],
    ["context-package.schema.json", "templates/reports/context-package.example.json"],
    ["source-map.schema.json", "templates/reports/source-map.example.json"],
    ["review.schema.json", "templates/reports/review.example.json"],
    ["manifest.schema.json", "tests/fixtures/manifest/valid-minimal.json"],
    ["review-finding.schema.json", "templates/reports/review-finding.example.json"],
    ["independent-review.schema.json", "templates/reports/independent-review.example.json"],
    ["repair-task.schema.json", "templates/reports/repair-task.example.json"],
    ["repair-attempt.schema.json", "templates/reports/repair-attempt.example.json"],
    ["repair-budget.schema.json", "templates/reports/repair-budget.example.json"],
    ["repeated-failure-signature.schema.json", "templates/reports/repeated-failure-signature.example.json"],
    ["graph-revision.schema.json", "templates/reports/graph-revision.example.json"],
    ["superseded-run.schema.json", "templates/reports/superseded-run.example.json"]
  ] as const;

  for (const [schemaName, examplePath] of validExamples) {
    it(`validates ${examplePath}`, () => {
      assert.deepEqual(registry.validate(schemaName, readJson(examplePath)), { valid: true, errors: [] });
    });
  }

  it("reports useful issue paths for invalid fixtures", () => {
    const result = registry.validate("manifest.schema.json", readJson("tests/fixtures/manifest/invalid-proposed-plan.json"));

    assert.equal(result.valid, false);
    assert.ok(result.errors.some((issue) => issue.instancePath === "/plan/status" && issue.keyword === "enum"));
  });

  it("reports useful issue paths for an invalid repair task", () => {
    const result = registry.validate(
      "repair-task.schema.json",
      readJson("tests/fixtures/repair/invalid-repair-task-missing-allowed-paths.json")
    );

    assert.equal(result.valid, false);
    assert.ok(result.errors.some((issue) => issue.keyword === "required" && issue.message.includes("allowedPaths")));
  });
});

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8"));
}
