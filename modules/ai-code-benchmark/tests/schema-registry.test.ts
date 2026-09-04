import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { schemaRegistry } from "../src/schema-registry.js";

test("BENCH-02 registry installs exactly the versioned contracts and fails closed", () => {
  const expected = ["benchmark-suite.schema.json", "benchmark-task.schema.json", "benchmark-environment.schema.json", "benchmark-experiment.schema.json", "benchmark-observation.schema.json", "benchmark-intervention.schema.json", "benchmark-evaluation.schema.json", "benchmark-report.schema.json", "candidate-hypothesis.schema.json", "benchmark-event.schema.json"].sort();
  assert.deepEqual(schemaRegistry.names(), expected);
  schemaRegistry.assertInstalled(expected);
  assert.throws(() => schemaRegistry.assertValid("unknown.schema.json", {}), /No registered schema/);
  assert.throws(() => schemaRegistry.assertValid("benchmark-suite.schema.json", { schemaVersion: "1.0", unexpected: true }), /must NOT have additional properties/);
});

test("the mandatory P5 candidate template remains a valid versioned hypothesis contract", () => {
  const templatePath = fileURLToPath(new URL("../../templates/candidate-hypothesis.template.json", import.meta.url));
  const template = JSON.parse(readFileSync(templatePath, "utf8"));
  assert.doesNotThrow(() => schemaRegistry.assertValid("candidate-hypothesis.schema.json", template));
});
