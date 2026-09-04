import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { canonicalJson, sha256CanonicalJson } from "../src/canonical-json.js";
import { assertExperimentMatchesSuite, loadSuite, resolveContained } from "../src/dataset.js";
import { freezeExperiment } from "../src/experiment.js";

const genericSuite = fileURLToPath(new URL("../../datasets/generic-v1/suite.json", import.meta.url));

test("generic-v1 loads exactly twelve deterministic tasks with evaluator-only oracle references", () => {
  const suite = loadSuite(genericSuite);
  assert.equal(suite.value.id, "generic-v1");
  assert.equal(suite.tasks.length, 12);
  assert.equal(new Set(suite.tasks.map((task) => task.value.id)).size, 12);
  for (const task of suite.tasks) {
    const oracle = task.value.oracle as Record<string, unknown>;
    assert.deepEqual(Object.keys(oracle).sort(), ["access", "oracleRef"]);
    assert.equal(oracle.access, "evaluator-only");
    assert.match(oracle.oracleRef as string, /^evaluator-oracles\//);
  }
});

test("canonical JSON hashing is stable across key order and Windows line endings", () => {
  assert.equal(canonicalJson({ b: "one\r\ntwo", a: [2, 1] }), canonicalJson({ a: [2, 1], b: "one\ntwo" }));
  assert.equal(sha256CanonicalJson({ b: 1, a: 2 }), sha256CanonicalJson({ a: 2, b: 1 }));
});

test("dataset loader rejects traversal and duplicate task ids", () => {
  const directory = mkdtempSync(join(tmpdir(), "benchmark-dataset-"));
  try {
    assert.throws(() => resolveContained(directory, "../escape.json"), /escapes|Invalid relative/);
    mkdirSync(join(directory, "tasks"));
    const task = { schemaVersion: "1.0", id: "duplicate-task", version: "v1", kind: "mechanical-local", risk: "low", languages: ["typescript"], difficulty: "easy", inclusionReason: "test", prompt: "test", initialState: { repository: "fixture", revision: "0000000" }, setup: [], scope: { allow: ["src"], deny: [] }, verification: [{ command: ["npm", "test"], timeoutSeconds: 1 }], oracle: { access: "evaluator-only", oracleRef: "evaluator-oracles/test.json" }, limits: { timeoutSeconds: 1, maximumOutputBytes: 1 }, expectedOutcome: "PASS", dataClassification: "public" };
    writeFileSync(join(directory, "tasks", "one.json"), JSON.stringify(task));
    writeFileSync(join(directory, "tasks", "two.json"), JSON.stringify(task));
    const suite = { schemaVersion: "1.0", id: "test-suite", version: "v1", kind: "generic", taskFiles: ["tasks/one.json", "tasks/two.json"], arms: [{ id: "direct", kind: "direct", provider: null, model: null, effort: null }], repetitions: 1, metrics: ["verified-task-success"], thresholds: {}, budgets: { maximumInvocations: 0, maximumMinutes: 0, maximumCostUsd: null }, oracleAccess: "evaluator-only" };
    writeFileSync(join(directory, "suite.json"), JSON.stringify(suite));
    assert.throws(() => loadSuite(join(directory, "suite.json")), /Duplicate task id/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("freeze includes a stable canonical experiment hash", () => {
  const suite = loadSuite(genericSuite);
  const environment = { schemaVersion: "1.0", id: "test-environment", os: "test", architecture: "x64", toolchain: { node: "v22" }, hardware: null, cliVersions: {}, modulePins: {}, redactedConfiguration: {} };
  const experiment = freezeExperiment(suite, environment, "exp-fixture");
  assert.match(experiment.experimentHash as string, /^[a-f0-9]{64}$/);
  assert.equal(experiment.experimentHash, sha256CanonicalJson(Object.fromEntries(Object.entries(experiment).filter(([key]) => key !== "experimentHash"))));
  assert.throws(() => assertExperimentMatchesSuite({ ...experiment, taskHashes: { "missing-task": "a".repeat(64) } }, suite), /dangling or missing task IDs/);
  assert.throws(() => assertExperimentMatchesSuite({ ...experiment, arms: [{ id: "missing-arm" }] }, suite), /arms differ|dangling arm ID/);
  assert.throws(() => assertExperimentMatchesSuite({ ...experiment, arms: [{ ...(experiment.arms as Record<string, unknown>[])[0], kind: "full-icm" }] }, suite), /arms differ/);
});
