import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, existsSync, readFileSync, readdirSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildPilotAdapterRequest, pilotPreflight, runPilot } from "../src/pilot/driver.js";
import { writePilotExperiment } from "../src/pilot/preregistration.js";
import { applyFakeSolution, buildPilotCampaignRepository, pilotWorkerBudgets } from "../src/pilot/tasks.js";
import { loadPilotSuite } from "../src/pilot/preregistration.js";

test("BENCH-09 fake driver runs the complete 10 x 3 matrix and keeps split reports", async () => {
  const suiteRoot = fileURLToPath(new URL("../../../../validation/benchmark/pilot/", import.meta.url));
  const repo = mkdtempSync(join(tmpdir(), "bench-09-test-repo-"));
  const state = mkdtempSync(join(tmpdir(), "bench-09-test-state-"));
  const preflight = await pilotPreflight({ suiteRoot, repositoryPath: repo, stateRoot: state, fake: true });
  assert.equal(preflight.ok, true);
  assert.equal(preflight.experiment.maximumInvocations, 30);
  assert.deepEqual(preflight.checks.find((check) => check.id === "fixture-transitions"), { id: "fixture-transitions", status: "PASS", positiveTransitions: 9, expectedBlockedOracles: 1 });
  const experimentPath = join(state, "experiment.json"); writePilotExperiment(preflight.experiment, experimentPath);
  const result = await runPilot({ suiteRoot, repositoryPath: repo, stateRoot: state, experimentPath, configPath: join(repo, "config.json"), fake: true });
  assert.equal((result.runtime as { total: number }).total, 30); assert.equal((result.evaluated as { count: number }).count, 30);
  const report = result.report as { counts: Record<string, number>; categories: Record<string, unknown>; aggregates: Record<string, { validCount: number }>; limitations: string[] };
  assert.equal(report.counts.paired, 10); assert.equal(report.counts.missingIdentity, 0);
  assert.equal(Object.hasOwn(report.categories, "uncategorized"), false);
  // The expected-BLOCKED negative task intentionally performs no provider work,
  // so usage remains unknown instead of being invented as zero.
  assert.equal(report.aggregates["direct.inputTokens"]?.validCount, 9);
  assert.equal(report.limitations.includes("CRITICAL_SAFETY_FAILURE"), false);
  const artifactRoot = join(state, "benchmarks", String(preflight.experiment.id));
  assert.equal(existsSync(join(artifactRoot, "raw-private", "index.json")), true);
  assert.equal(existsSync(join(artifactRoot, "redacted", "REPORT.md")), true);
  assert.equal(readFileSync(join(artifactRoot, "interventions.jsonl"), "utf8").split("\n").filter(Boolean).length, 1);
  const evaluations = readdirSync(join(artifactRoot, "evaluations")).map((name) => JSON.parse(readFileSync(join(artifactRoot, "evaluations", name), "utf8")) as { verdict: string; evidence: { changedPaths: string[] } });
  assert.equal(evaluations.length, 30);
  assert.ok(evaluations.every((item) => item.verdict === "PASS"));
  assert.ok(evaluations.every((item) => item.evidence.changedPaths.every((path) => !path.startsWith(".ai-code-worker/") && !path.startsWith("Plan/"))));
});

test("pilot plans and adapter requests preserve each exact generic prompt with identical v1.1 budgets", () => {
  const suiteRoot = fileURLToPath(new URL("../../../../validation/benchmark/pilot/", import.meta.url));
  const suite = loadPilotSuite(suiteRoot); const repository = mkdtempSync(join(tmpdir(), "bench-09-plan-contract-"));
  buildPilotCampaignRepository(repository, suite.tasks.map((task) => task.value));
  for (const loaded of suite.tasks) {
    const task = loaded.value; const id = String(task.id); const prompt = String(task.prompt); const planPath = join(repository, "Plan", `${id}.md`);
    const match = /```json ai-code-worker-plan\r?\n([\s\S]*?)\r?\n```/u.exec(readFileSync(planPath, "utf8")); assert.ok(match);
    const body = JSON.parse(match[1]!) as { workerContractVersion: string; goal: string; budgets: unknown; tasks: readonly { role: string; acceptanceCriteria: readonly string[]; traceability: { acceptanceCriteria: readonly { text: string }[] } }[] };
    assert.equal(body.workerContractVersion, "1.1"); assert.equal(body.goal, prompt); assert.deepEqual(body.budgets, pilotWorkerBudgets()); assert.equal(body.tasks[0]?.role, prompt); assert.equal(body.tasks[0]?.acceptanceCriteria[0], prompt); assert.equal(body.tasks[0]?.traceability.acceptanceCriteria[0]?.text, prompt);
    const request = buildPilotAdapterRequest({ arm: "full-icm", repositoryPath: repository, taskId: id as never, seed: 1, prompt, planPath });
    assert.equal(request.prompt, prompt); assert.notEqual(request.prompt, id);
  }
});

test("the evaluator v1.1 plan compiles and runs through the public root for B", () => {
  const suiteRoot = fileURLToPath(new URL("../../../../validation/benchmark/pilot/", import.meta.url)); const suite = loadPilotSuite(suiteRoot);
  const repository = mkdtempSync(join(tmpdir(), "bench-09-public-root-")); const state = mkdtempSync(join(tmpdir(), "bench-09-public-root-state-"));
  buildPilotCampaignRepository(repository, suite.tasks.map((task) => task.value)); applyFakeSolution(repository, "rename-local");
  const worker = join(repository, ".ai-code-worker"); mkdirSync(worker, { recursive: true });
  writeFileSync(join(worker, "config.json"), JSON.stringify({ schemaVersion: "1.0", contextProvider: "none", contextPackage: { mode: "off", maximumTokens: 12000 }, stateRoot: state, maximumParallelWriters: 1, syncRootPolicy: { sequentialWriter: "warn", parallelWriters: "block" } }), "utf8");
  execFileSync("git", ["init", "--quiet"], { cwd: repository, stdio: "ignore" }); execFileSync("git", ["-c", "user.name=benchmark", "-c", "user.email=benchmark@localhost", "add", "."], { cwd: repository, stdio: "ignore" }); execFileSync("git", ["-c", "user.name=benchmark", "-c", "user.email=benchmark@localhost", "commit", "--quiet", "-m", "fixture"], { cwd: repository, stdio: "ignore" });
  const rootCli = fileURLToPath(new URL("../../../../dist/src/cli.js", import.meta.url));
  assert.equal(existsSync(rootCli), true, "public root CLI must be built before the bundle contract test");
  const isolatedEnvironment = { ...process.env, ...(process.platform === "win32" ? { LOCALAPPDATA: state } : { XDG_STATE_HOME: state }) };
  const envelope = JSON.parse(execFileSync(process.execPath, [rootCli, "run", "--repo", repository, "--plan", "Plan/rename-local.md", "--engine", "fake", "--no-estimate"], { cwd: repository, encoding: "utf8", env: isolatedEnvironment })) as { status: string; body: { status: string; compile: { status: string } } };
  assert.equal(envelope.status, "PASS"); assert.equal(envelope.body.status, "DONE"); assert.equal(envelope.body.compile.status, "PASS");
});
