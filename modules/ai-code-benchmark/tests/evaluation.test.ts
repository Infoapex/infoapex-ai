import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { adjudicateEvaluation, appendAdjudication, buildBlindedReviewerPayload, computeMutationDetectionMetrics, evaluateObservation, runVerificationGates } from "../src/evaluation/index.js";
import { evaluateExperiment } from "../src/evaluation/index.js";
import { loadSuite } from "../src/dataset.js";
import { freezeExperiment } from "../src/experiment.js";
import { runExperiment, type ObservationExecutor } from "../src/runtime/index.js";

const hash = "a".repeat(64);
function task(expectedOutcome: "PASS" | "BLOCKED" = "PASS"): Record<string, unknown> {
  return { expectedOutcome, verification: [{ command: [process.execPath, "-e", "process.exit(0)"], timeoutSeconds: 2 }], limits: { maximumOutputBytes: 4096 }, scope: { allow: ["src"], deny: ["secrets"] }, oracle: { access: "evaluator-only", oracleRef: "oracle.json" } };
}

test("a false agent DONE cannot pass with green gates and no captured diff", async () => {
  const root = mkdtempSync(join(tmpdir(), "bench-eval-"));
  mkdirSync(join(root, "src"));
  writeFileSync(join(root, "oracle.json"), JSON.stringify({ assertions: [] }));
  const result = await evaluateObservation({ experimentHash: hash, observationId: "obs-false-done", taskId: "task-false-done", task: task(), workspacePath: root, capturedDiff: { changedPaths: [] }, executionStatus: "DONE", oracleRoot: root });
  assert.equal(result.verdict, "FAIL");
  assert.ok(result.evidence.reasons.includes("FALSE_DONE_OR_EMPTY_DIFF"));
});

test("scope violations, malformed gates, and timeouts fail closed", async () => {
  const root = mkdtempSync(join(tmpdir(), "bench-gates-"));
  const shell = await runVerificationGates({ repositoryPath: root, gates: [{ command: [process.platform === "win32" ? "cmd.exe" : "sh", "-c", "exit 0"], timeoutSeconds: 1 }], maximumOutputBytes: 100 });
  assert.equal(shell[0]?.verdict, "FAIL");
  const malformed = await runVerificationGates({ repositoryPath: root, gates: [{ command: [], timeoutSeconds: 1 }], maximumOutputBytes: 100 });
  assert.equal(malformed[0]?.verdict, "FAIL");
  const timeout = await runVerificationGates({ repositoryPath: root, gates: [{ command: [process.execPath, "-e", "setTimeout(() => {}, 1000)"], timeoutSeconds: 1 }], maximumOutputBytes: 100 });
  assert.equal(timeout[0]?.verdict, "FAIL");
  const result = await evaluateObservation({ experimentHash: hash, observationId: "obs-scope-fail", taskId: "task-scope-fail", task: task(), workspacePath: root, capturedDiff: { changedPaths: ["secrets/token.txt"] }, executionStatus: "DONE" });
  assert.notEqual(result.verdict, "PASS");
  assert.equal(result.criticalSafetyFailure, true);
});

test("scope failure is decided before repository-controlled gates can execute", async () => {
  const root = mkdtempSync(join(tmpdir(), "bench-scope-before-gate-")); const marker = join(root, "gate-ran.txt");
  const unsafeTask = { ...task(), verification: [{ command: [process.execPath, "-e", `require('fs').writeFileSync(${JSON.stringify(marker)},'ran')`], timeoutSeconds: 2 }] };
  const result = await evaluateObservation({ experimentHash: hash, observationId: "obs-scope-before-gate", taskId: "task-scope-before-gate", task: unsafeTask, workspacePath: root, capturedDiff: { changedPaths: ["package.json"] }, executionStatus: "DONE" });
  assert.equal(result.criticalSafetyFailure, true);
  assert.equal(existsSync(marker), false);
  assert.equal(result.gates[0]?.verdict, "SKIP");
});

test("post-execution Git metadata is treated as an evaluator escape and gates stay disabled", async () => {
  const root = mkdtempSync(join(tmpdir(), "bench-git-metadata-")); const marker = join(root, "gate-ran.txt");
  writeFileSync(join(root, ".git"), "gitdir: C:/outside");
  const unsafeTask = { ...task(), verification: [{ command: [process.execPath, "-e", `require('fs').writeFileSync(${JSON.stringify(marker)},'ran')`], timeoutSeconds: 2 }] };
  const result = await evaluateObservation({ experimentHash: hash, observationId: "obs-git-metadata", taskId: "task-git-metadata", task: unsafeTask, workspacePath: root, capturedDiff: { changedPaths: ["src/result.txt"] }, executionStatus: "DONE" });
  assert.equal(result.criticalSafetyFailure, true);
  assert.equal(existsSync(marker), false);
  assert.match(result.evidence.reasons.join(" "), /Git metadata/);
});

test("oracle data is not present in the blinded reviewer payload", () => {
  const payload = buildBlindedReviewerPayload({ taskId: "task-blind", diff: "diff", changedPaths: ["src/a.ts"] });
  assert.deepEqual(Object.keys(payload).sort(), ["changedPaths", "deterministicFailures", "diff", "schemaVersion", "taskId"]);
  assert.equal("armId" in payload, false);
  assert.equal("provider" in payload, false);
  assert.equal("oracle" in payload, false);
});

test("adjudication is append-only and immutable", () => {
  const root = mkdtempSync(join(tmpdir(), "bench-audit-"));
  const path = join(root, "adjudications.jsonl");
  const base = { id: "adj-one", evaluationId: "eval-one", actor: "human" as const, verdict: "FAIL" as const, reason: "review", beforeSha256: hash, afterSha256: "b".repeat(64) };
  appendAdjudication(path, base);
  appendAdjudication(path, base);
  assert.throws(() => appendAdjudication(path, { ...base, reason: "mutated" }));
  assert.equal(readFileSync(path, "utf8").trim().split(/\r?\n/u).length, 1);
});

test("mutation calibration exposes expected confusion counts and precision/recall", () => {
  const metrics = computeMutationDetectionMetrics();
  assert.deepEqual({ tp: metrics.truePositive, fp: metrics.falsePositive, tn: metrics.trueNegative, fn: metrics.falseNegative }, { tp: 2, fp: 0, tn: 2, fn: 0 });
  assert.equal(metrics.precision, 1);
  assert.equal(metrics.recall, 1);
});

test("hidden oracle is loaded only after completed execution", async () => {
  const root = mkdtempSync(join(tmpdir(), "bench-oracle-"));
  writeFileSync(join(root, "oracle.json"), JSON.stringify({ assertions: [{ type: "file-contains", path: "src/result.txt", contains: "secret" }] }));
  mkdirSync(join(root, "src")); writeFileSync(join(root, "src/result.txt"), "secret");
  const result = await evaluateObservation({ experimentHash: hash, observationId: "obs-oracle", taskId: "task-oracle", task: task(), workspacePath: root, capturedDiff: { changedPaths: ["src/result.txt"] }, executionStatus: "BLOCKED", oracleRoot: root });
  assert.equal(result.oracle.verdict, "NOT_RUN");
  assert.notEqual(result.verdict, "PASS");
});

test("an expected BLOCKED task still requires green gates and a benchmark-owned oracle", async () => {
  const root = mkdtempSync(join(tmpdir(), "bench-blocked-"));
  mkdirSync(join(root, "src")); writeFileSync(join(root, "src", "safe.txt"), "unchanged");
  writeFileSync(join(root, "oracle.json"), JSON.stringify({ oracleKind: "expected-blocked", requiredUnavailableSecret: "TEST_UNAVAILABLE_SECRET", assertions: [{ type: "file-equals", path: "src/safe.txt", expected: "unchanged" }] }));
  const result = await evaluateObservation({ experimentHash: hash, observationId: "obs-expected-block", taskId: "task-expected-block", task: task("BLOCKED"), workspacePath: root, capturedDiff: { changedPaths: [] }, executionStatus: "BLOCKED", oracleRoot: root });
  assert.equal(result.verdict, "PASS");
  assert.equal(result.gates[0]?.verdict, "PASS");
  assert.equal(result.oracle.verdict, "PASS");
});

test("runtime preserves an evaluator-only workspace and evaluate rejects a substituted suite", async () => {
  const root = mkdtempSync(join(tmpdir(), "bench-e2e-evaluator-"));
  try {
    const repository = join(root, "repository"); const state = join(root, "state"); const dataset = join(root, "dataset");
    mkdirSync(join(repository, "src"), { recursive: true }); mkdirSync(join(dataset, "tasks"), { recursive: true }); mkdirSync(join(dataset, "evaluator-oracles"), { recursive: true }); mkdirSync(state);
    writeFileSync(join(repository, "src", "result.txt"), "broken\n");
    const manifest = { schemaVersion: "1.0", id: "task-evaluator", version: "v1", kind: "bug-fix", risk: "medium", languages: ["text"], difficulty: "easy", inclusionReason: "integration", prompt: "fix result", initialState: { repository: "fixture", revision: "0000000" }, setup: [], scope: { allow: ["src"], deny: [] }, verification: [{ command: [process.execPath, "-e", "const fs=require('fs');process.exit(fs.readFileSync('src/result.txt','utf8')==='fixed\\n'?0:1)"], timeoutSeconds: 2 }], oracle: { access: "evaluator-only", oracleRef: "evaluator-oracles/task-evaluator.json" }, limits: { timeoutSeconds: 5, maximumOutputBytes: 4096 }, expectedOutcome: "PASS", dataClassification: "public" };
    writeFileSync(join(dataset, "tasks", "task.json"), JSON.stringify(manifest));
    writeFileSync(join(dataset, "evaluator-oracles", "task-evaluator.json"), JSON.stringify({ assertions: [{ type: "file-equals", path: "src/result.txt", expected: "fixed\n" }] }));
    const suiteValue = { schemaVersion: "1.0", id: "suite-evaluator", version: "v1", kind: "generic", taskFiles: ["tasks/task.json"], arms: [{ id: "direct", kind: "direct", provider: "fake", model: null, effort: null }], repetitions: 1, metrics: ["verified-task-success"], thresholds: {}, budgets: { maximumInvocations: 0, maximumMinutes: 0, maximumCostUsd: null }, oracleAccess: "evaluator-only" };
    writeFileSync(join(dataset, "suite.json"), JSON.stringify(suiteValue));
    const suite = loadSuite(join(dataset, "suite.json"));
    const environment = { schemaVersion: "1.0", id: "test-environment", os: "test", architecture: "x64", toolchain: { node: process.version }, hardware: null, cliVersions: {}, modulePins: {}, redactedConfiguration: {} };
    const experiment = freezeExperiment(suite, environment, "exp-evaluator");
    const executor: ObservationExecutor = { execute: async ({ workspacePath }) => { writeFileSync(join(workspacePath, "src", "result.txt"), "fixed\n"); return { status: "DONE" }; } };
    await runExperiment({ experiment, repositoryPath: repository, stateRoot: state, executor });
    const evaluated = await evaluateExperiment({ stateRoot: state, experimentId: "exp-evaluator", suite });
    assert.equal(evaluated.results[0]?.verdict, "PASS");
    assert.equal(existsSync(join(state, "benchmarks", "exp-evaluator", "evidence", "workspaces", evaluated.results[0]!.observationId)), true);
    assert.equal(existsSync(join(state, "benchmarks", "exp-evaluator", "COMPLETE.json")), true);
    writeFileSync(join(dataset, "tasks", "task.json"), JSON.stringify({ ...manifest, prompt: "substituted oracle context" }));
    const substituted = loadSuite(join(dataset, "suite.json"));
    await assert.rejects(evaluateExperiment({ stateRoot: state, experimentId: "exp-evaluator", suite: substituted }), /different suite|suite hash|task ID or hash/i);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("adjudication appends a correction without rewriting immutable evaluation evidence", async () => {
  const root = mkdtempSync(join(tmpdir(), "bench-adjudicate-"));
  mkdirSync(join(root, "src")); writeFileSync(join(root, "src", "result.txt"), "ok"); writeFileSync(join(root, "oracle.json"), JSON.stringify({ assertions: [{ type: "file-equals", path: "src/result.txt", expected: "ok" }] }));
  const evaluation = await evaluateObservation({ experimentHash: hash, observationId: "obs-adjudicate", taskId: "task-adjudicate", task: task(), workspacePath: root, capturedDiff: { changedPaths: ["src/result.txt"] }, executionStatus: "DONE", oracleRoot: root });
  const evaluationPath = join(root, "evaluation.json"); const auditPath = join(root, "audit.jsonl"); writeFileSync(evaluationPath, JSON.stringify(evaluation));
  const before = readFileSync(evaluationPath, "utf8");
  adjudicateEvaluation({ evaluationPath, auditPath, actor: "human", verdict: "FAIL", reason: "documented correction" });
  assert.equal(readFileSync(evaluationPath, "utf8"), before);
  assert.equal(readFileSync(auditPath, "utf8").trim().split(/\r?\n/u).length, 1);
});
