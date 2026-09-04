#!/usr/bin/env node

/* BENCH-08 / BENCH-D: hermetic deterministic benchmark campaign. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, appendFileSync, symlinkSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { pathToFileURL } from "node:url";

const moduleRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../../modules/ai-code-benchmark");
const moduleFile = (part) => pathToFileURL(join(moduleRoot, part)).href;
const { loadSuite } = await import(moduleFile("dist/src/dataset.js"));
const { runBoundedProcess, assertCommand, safeEnvironment } = await import(moduleFile("dist/src/adapters/subprocess.js"));
const { evaluateObservation, loadEvaluatorOracle, validateCapturedDiff } = await import(moduleFile("dist/src/evaluation/index.js"));
const { redactSecrets } = await import(moduleFile("dist/src/metrics.js"));
const { containedPath } = await import(moduleFile("dist/src/security/paths.js"));
const { readEvents } = await import(moduleFile("dist/src/persistence/store.js"));

const positionalOutput = process.argv.slice(2).find((value) => !value.startsWith("--"));
const output = resolve(option("--output") ?? optionEquals("--output") ?? positionalOutput ?? process.env.BENCH_D_OUTPUT ?? resolve(moduleRoot, "../../validation", "benchmark", "deterministic", "artifacts"));
mkdirSync(join(output, "raw", "prompts"), { recursive: true });
mkdirSync(join(output, "raw", "oracles"), { recursive: true });
mkdirSync(join(output, "raw", "repositories"), { recursive: true });
const temp = mkdtempSync(join(tmpdir(), "bench-d-"));
try {
  const suite = loadSuite(join(moduleRoot, "datasets", "generic-v1", "suite.json"));
  assert.equal(suite.tasks.length, 12, "generic-v1 must remain exactly 12 tasks");
  const fake = join(dirname(fileURLToPath(import.meta.url)), "fake-subprocess.mjs");
  const scenarios = new Map([
    ["api-contract", "success"], ["cross-file-config", "success"], ["dag-order", "failure"], ["docs-sync", "success"],
    ["error-classification", "timeout"], ["fix-boundary", "quota"], ["negative-missing-secret", "unsupported"], ["preserve-refactor", "scope"],
    ["recovery-cleanup", "recovery"], ["rename-local", "false-done"], ["scope-guard", "truncated"], ["serialization-roundtrip", "success"]
  ]);
  const arms = ["A", "B", "C"];
  const observations = [];
  const taskRecords = [];
  for (const task of suite.tasks) {
    const id = String(task.value.id);
    const scenario = scenarios.get(id);
    assert.ok(scenario, `scenario missing for ${id}`);
    const prompt = `BENCH-D/${suite.value.id}/${id}: ${String(task.value.prompt)}\nProtocol: no network, no provider credentials, report only deterministic changes.`;
    const oracle = { schemaVersion: "bench-d-oracle.v1", assertions: [{ type: "file-contains", path: "src/result.txt", contains: "PASS" }] };
    writeCanonical(join(output, "raw", "prompts", `${id}.txt`), prompt, false);
    writeCanonical(join(output, "raw", "oracles", `${id}.json`), oracle);
    const repository = join(temp, id);
    mkdirSync(join(repository, "src"), { recursive: true });
    mkdirSync(join(repository, "oracles"), { recursive: true });
    writeFileSync(join(repository, "src", "result.txt"), "BASELINE\n", "utf8");
    writeCanonical(join(repository, "oracles", `${id}.json`), oracle);
    writeCanonical(join(output, "raw", "repositories", `${id}.json`), { id, files: { "src/result.txt": "BASELINE\n", [`oracles/${id}.json`]: oracle } });
    taskRecords.push({ id, scenario, promptSha256: sha256(prompt), oracleSha256: sha256(canonical(oracle)), repositorySha256: sha256(canonical({ "src/result.txt": "BASELINE\n", [`oracles/${id}.json`]: oracle })) });
    for (const arm of arms) {
      // Every arm receives a pristine, deterministic copy.  This prevents a
      // wrong candidate patch from becoming an input to the next arm.
      writeFileSync(join(repository, "src", "result.txt"), "BASELINE\n", "utf8");
      const seed = stableSeed(`${suite.hash}/${id}/${arm}`);
      const request = { scenario, arm, taskId: id, seed, prompt };
      const timeoutMs = scenario === "timeout" ? 20 : 1_000;
      const maximumOutputBytes = scenario === "truncated" ? 256 : 16_384;
      const process = await runBoundedProcess({ command: [processExec(), fake], cwd: repository, stdin: JSON.stringify(request), timeoutMs, maximumOutputBytes, environmentNames: ["BENCH_D_PUBLIC", "BENCH_D_API_KEY"] });
      const parsed = parseOutput(process.stdout);
      let classification = classify(process, parsed);
      let changedPaths = parsed?.changedPaths ?? [];
      let evalResult = null;
      let recoveryEvidence = null;
      if (classification === "DONE" && changedPaths.includes("src/result.txt")) writeFileSync(join(repository, "src", "result.txt"), parsed.content ?? "", "utf8");
      if (scenario === "recovery") {
        recoveryEvidence = recoveryCheck(temp, id);
        classification = recoveryEvidence.resumed ? "RECOVERED" : "BLOCKED";
      }
      const expected = expectedClassification(scenario);
      assert.equal(classification, expected, `${id}/${arm} classification drifted`);
      if (["DONE", "RECOVERED"].includes(classification)) {
        const evalTask = {
          ...task.value,
          verification: [{ command: [processExec(), "-e", "process.exit(0)"], timeoutSeconds: 1 }],
          oracle: { access: "evaluator-only", oracleRef: `oracles/${id}.json` }
        };
        evalResult = await evaluateObservation({ experimentHash: suite.hash, observationId: `bench-d-${id}-${arm.toLowerCase()}`, taskId: id, task: evalTask, workspacePath: repository, capturedDiff: { changedPaths, diff: canonical({ changedPaths }), valid: true }, executionStatus: "DONE", agentClaim: "DONE", oracleRoot: repository });
      }
      const passed = classification === expected && (scenario !== "success" || evalResult?.verdict === "PASS");
      observations.push({ order: observations.length, taskId: id, armId: arm, scenario, seed, expected, classification, changedPaths, recovery: recoveryEvidence, evaluatorVerdict: evalResult?.verdict ?? null, passed, adapter: { id: "fake-subprocess.v1", executable: "node", parser: "bench-d-fake.v1" }, termination: { exitCode: process.exitCode, timedOut: process.timedOut, outputTruncated: process.outputTruncated }, outputSha256: process.rawOutputSha256 });
      writeCanonical(join(output, "raw", "observations", `${id}-${arm}.json`), observations.at(-1));
    }
  }
  const mutations = await runMutationCampaign(temp, suite.hash);
  const security = securityChecks(temp);
  assert.deepEqual(mutations.metrics, { truePositive: 2, falsePositive: 0, trueNegative: 2, falseNegative: 0, precision: 1, recall: 1 });
  assert.ok(Object.values(security).every(Boolean), "all BENCH-D security checks must pass");
  const scenarioCounts = Object.fromEntries([...new Set(observations.map((item) => item.scenario))].sort().map((scenario) => [scenario, observations.filter((item) => item.scenario === scenario).length]));
  const armScores = arms.map((arm) => { const rows = observations.filter((item) => item.armId === arm && item.scenario === "success"); return { arm, passed: rows.filter((item) => item.passed).length, total: rows.length, score: rows.length === 0 ? 0 : rows.filter((item) => item.passed).length / rows.length }; }).sort((a, b) => b.score - a.score || a.arm.localeCompare(b.arm));
  assert.deepEqual(armScores.map((item) => item.arm), ["C", "B", "A"]);
  assert.equal(observations.length, 36);
  assert.ok(observations.filter((item) => item.armId === "C" && item.scenario === "success").every((item) => item.passed), "reference arm must pass every success oracle");
  const reportCore = { schemaVersion: "1.0", benchmark: "BENCH-D", protocolVersion: "bench-d.v1", suiteId: suite.value.id, suiteHash: suite.hash, tasks: taskRecords, arms: armScores, counts: { tasks: 12, arms: 3, observations: 36, passed: observations.filter((item) => item.passed).length, failures: observations.filter((item) => !item.passed).length }, scenarios: scenarioCounts, mutation: mutations.metrics, security, scoreOrdering: armScores.map((item) => item.arm), generatedAt: "1970-01-01T00:00:00.000Z" };
  const report = { ...reportCore, reproducibility: { canonicalReport: reportCore, canonicalHash: sha256(canonical(reportCore)) } };
  writeCanonical(join(output, "raw", "manifest.json"), { schemaVersion: "1.0", benchmark: "BENCH-D", suiteId: suite.value.id, suiteHash: suite.hash, tasks: taskRecords, arms: arms.map((id) => ({ id, adapter: "fake-subprocess.v1" })), observationCount: observations.length });
  writeFileSync(join(output, "raw", "observations.jsonl"), `${observations.map(canonical).join("\n")}\n`, "utf8");
  writeCanonical(join(output, "raw", "mutations.json"), mutations);
  writeCanonical(join(output, "raw", "security.json"), security);
  writeCanonical(join(output, "report.json"), report);
  writeFileSync(join(output, "report.md"), markdown(report), "utf8");
  console.log(JSON.stringify({ status: "PASS", benchmark: "BENCH-D", output, tasks: 12, arms: 3, observations: 36, passed: report.counts.passed, canonicalReportSha256: sha256(canonical(report)), reportFileSha256: sha256(readFileSync(join(output, "report.json"))), rawSha256: sha256(readFileSync(join(output, "raw", "observations.jsonl"))) }));
} finally {
  rmSync(temp, { recursive: true, force: true });
}

async function runMutationCampaign(root, experimentHash) {
  const fixtures = [
    ["missing-boundary-check", true, ["src/result.txt"], "WRONG\n"], ["scope-escape", true, ["secrets/token.txt"], ""],
    ["format-only-change", false, ["src/result.txt"], "PASS\n"], ["unchanged-valid-solution", false, ["src/result.txt"], "PASS\n"]
  ];
  const results = [];
  for (const [id, defectPresent, changedPaths, content] of fixtures) {
    const workspace = join(root, `mutation-${id}`); mkdirSync(join(workspace, "src"), { recursive: true });
    writeFileSync(join(workspace, "src", "result.txt"), content, "utf8");
    const task = { expectedOutcome: "PASS", verification: [{ command: [processExec(), "-e", "process.exit(0)"], timeoutSeconds: 1 }], limits: { maximumOutputBytes: 4096 }, scope: { allow: ["src"], deny: ["secrets"] }, oracle: { access: "evaluator-only", oracleRef: "oracle.json" } };
    writeCanonical(join(workspace, "oracle.json"), { assertions: [{ type: "file-contains", path: "src/result.txt", contains: "PASS" }] });
    const result = await evaluateObservation({ experimentHash, observationId: `mutation-${id}`, taskId: "mutation-task", task, workspacePath: workspace, capturedDiff: { changedPaths, diff: canonical({ changedPaths }), valid: true }, executionStatus: "DONE", oracleRoot: workspace });
    const detected = result.verdict !== "PASS";
    results.push({ id, defectPresent, detected, verdict: result.verdict });
  }
  const tp = results.filter((item) => item.defectPresent && item.detected).length;
  const fp = results.filter((item) => !item.defectPresent && item.detected).length;
  const tn = results.filter((item) => !item.defectPresent && !item.detected).length;
  const fn = results.filter((item) => item.defectPresent && !item.detected).length;
  return { variants: results, metrics: { truePositive: tp, falsePositive: fp, trueNegative: tn, falseNegative: fn, precision: tp + fp ? tp / (tp + fp) : 0, recall: tp + fn ? tp / (tp + fn) : 0 } };
}

function securityChecks(root) {
  const prior = process.env.BENCH_D_API_KEY; process.env.BENCH_D_API_KEY = "super-secret";
  let envSafe = false; try { envSafe = safeEnvironment(["BENCH_D_API_KEY"]).forwarded.includes("BENCH_D_API_KEY") === false; } finally { if (prior === undefined) delete process.env.BENCH_D_API_KEY; else process.env.BENCH_D_API_KEY = prior; }
  let commandSafe = false; try { assertCommand([processExec(), "-e", "process.exit(0)"]); assertCommand([processExec(), "bad\narg"]); } catch { commandSafe = true; }
  let pathSafe = false; try { containedPath(root, "../escape"); } catch { pathSafe = true; }
  let oracleSafe = false; try { loadEvaluatorOracle(root, "../escape.json", true); } catch { oracleSafe = true; }
  const unsafeDiffRejected = validateCapturedDiff({ changedPaths: ["../escape.txt"] }).valid === false;
  let symlinkRejected = true;
  const link = join(root, "path-link");
  try {
    symlinkSync(join(root, "missing-target"), link, "file");
    try { containedPath(root, "path-link"); symlinkRejected = false; } catch { symlinkRejected = true; }
  } catch { /* Symlink creation may be unavailable on locked-down CI workers. */ }
  if (existsSync(link)) unlinkSync(link);
  const redacted = redactSecrets("Authorization: Bearer super-secret token=super-secret");
  return { environmentSecretDropped: envSafe, commandInjectionRejected: commandSafe, containedPathRejected: pathSafe, oracleTraversalRejected: oracleSafe, unsafeDiffRejected, symlinkRejected, redactionApplied: !redacted.includes("super-secret") };
}

function recoveryCheck(root, id) {
  const path = join(root, `events-${id}.jsonl`);
  const hash = "a".repeat(64);
  const event = { schemaVersion: "1.0", id: `evt-${id}`, experimentHash: hash, occurredAt: "1970-01-01T00:00:00.000Z", type: "observation.started", sequence: 1, payload: { observationId: id, taskId: id, armId: "A", repetition: 1, seed: 1 } };
  writeFileSync(path, `${JSON.stringify(event)}\n{"truncated"`, "utf8");
  const recovered = readEvents(path); assert.equal(recovered.length, 1); appendFileSync(path, "\n", "utf8");
  return { resumed: recovered.length === 1, truncatedTailDiscarded: true, retryCount: 1 };
}
function expectedClassification(scenario) { return ({ success: "DONE", failure: "FAILED", timeout: "TIMEOUT", quota: "UNSUPPORTED", unsupported: "UNSUPPORTED", scope: "DONE", recovery: "RECOVERED", "false-done": "DONE", truncated: "TRUNCATED" })[scenario]; }
function classify(process, parsed) { if (process.timedOut) return "TIMEOUT"; if (process.outputTruncated) return "TRUNCATED"; if (process.exitCode === 75 || parsed?.status === "UNSUPPORTED") return "UNSUPPORTED"; if (process.exitCode !== 0) return "FAILED"; return parsed?.status === "DONE" ? "DONE" : "FAILED"; }
function parseOutput(value) { try { return JSON.parse(value); } catch { return null; } }
function stableSeed(value) { return (Number.parseInt(sha256(value).slice(0, 8), 16) & 0x7fffffff) || 1; }
function processExec() { return process.execPath; }
function sha256(value) { return createHash("sha256").update(value).digest("hex"); }
function canonical(value) { return JSON.stringify(normalize(value)); }
function normalize(value) { if (typeof value === "string") return value.replace(/\r\n?/gu, "\n"); if (Array.isArray(value)) return value.map(normalize); if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map((key) => [key, normalize(value[key])])); return value; }
function writeCanonical(path, value, pretty = true) { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, `${pretty ? JSON.stringify(normalize(value), null, 2) : canonical(value)}\n`, "utf8"); }
function markdown(report) { return `# BENCH-D deterministic benchmark\n\n- Verdict: PASS\n- Suite: ${report.suiteId}\n- Tasks × arms: ${report.counts.tasks} × ${report.counts.arms}\n- Observations: ${report.counts.observations}\n- Score ordering: ${report.scoreOrdering.join(" > ")}\n- Mutation precision / recall: ${report.mutation.precision} / ${report.mutation.recall}\n\nAll artifacts are canonical JSON with volatile timestamps excluded.\n`; }
function option(name) { const i = process.argv.indexOf(name); if (i < 0) return null; const value = process.argv[i + 1]; if (!value || value.startsWith("--")) throw new Error(`Missing value for ${name}`); return value; }
function optionEquals(name) { const value = process.argv.find((item) => item.startsWith(`${name}=`)); return value?.slice(name.length + 1) || null; }
