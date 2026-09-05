#!/usr/bin/env node
/*
 * Consumer BENCH-P runner. It is intentionally separate from the generic
 * fixture pilot: the repository under test is supplied by the operator and
 * every arm still gets an isolated safe-copy from the same frozen commit.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = resolve(fileURLToPath(new URL(".", import.meta.url)));
const bundleRoot = resolve(here, "../../..");
const moduleRoot = join(bundleRoot, "modules", "ai-code-benchmark", "dist", "src");
const { loadSuite } = await import(pathToFileURL(join(moduleRoot, "dataset.js")).href);
const { runExperiment } = await import(pathToFileURL(join(moduleRoot, "runtime", "index.js")).href);
const { evaluateExperiment } = await import(pathToFileURL(join(moduleRoot, "evaluation", "index.js")).href);
const { buildBenchmarkReport, renderMarkdownReport } = await import(pathToFileURL(join(moduleRoot, "report.js")).href);
const { DirectCodexAdapter } = await import(pathToFileURL(join(moduleRoot, "adapters", "direct-codex.js")).href);
const { DirectClaudeAdapter } = await import(pathToFileURL(join(moduleRoot, "adapters", "direct-claude.js")).href);
const { InfoapexRootAdapter } = await import(pathToFileURL(join(moduleRoot, "adapters", "infoapex-root.js")).href);

const repo = resolve(option("--repo") ?? "C:/__infoapex/eurocarscan");
const suitePath = resolve(option("--suite") ?? join(here, "suite.json"));
const experimentPath = resolve(option("--experiment") ?? join(here, ".local", "experiment.json"));
const stateRoot = resolve(option("--state-root") ?? join(repo, "..", `eurocarscan-benchmark-state-${provider()}`));
const suite = loadSuite(suitePath);
const experiment = JSON.parse(readFileSync(experimentPath, "utf8"));
const tasks = new Map(suite.tasks.map((task) => [String(task.value.id), task.value]));
assertFrozenRepositoryRevision(repo, suite);
const rootCli = join(bundleRoot, "dist", "src", "cli.js");
const controlDll = join(bundleRoot, "modules", "ai-code-control", "tools", "ai-code-control", "src", "AiCodeControl.Cli", "bin", "Release", "net9.0", "AiCodeControl.Cli.dll");
const codexCommand = [process.env.BENCH_CODEX_EXECUTABLE ?? "codex", "--config", 'windows.sandbox="unelevated"'];
const codexSandbox = process.env.BENCH_CODEX_SANDBOX ?? "danger-full-access";
const infoapexCommand = [process.execPath, rootCli];
const controlCommand = ["dotnet", controlDll];

if (!existsSync(repo)) throw new Error(`Repository does not exist: ${repo}`);
if (!option("--authorization")) throw new Error("Live consumer execution requires --authorization; no provider invocation was attempted.");
const authorization = JSON.parse(readFileSync(resolve(option("--authorization")), "utf8"));
if (authorization.experimentHash !== experiment.experimentHash || authorization.scope !== "EUROCARSCAN-P5") throw new Error("Authorization does not match the frozen EuroCarScan experiment.");

const armProviders = new Map(experiment.arms.map((arm) => [String(arm.id), String(arm.provider)]));
const adapters = new Map();
for (const providerName of new Set(armProviders.values())) {
  if (providerName === "codex") adapters.set("codex", new DirectCodexAdapter(codexCommand));
  else if (providerName === "claude") adapters.set("claude", new DirectClaudeAdapter(["claude"]));
  else throw new Error(`Unsupported consumer provider: ${providerName}`);
}
adapters.set("infoapex", new InfoapexRootAdapter(infoapexCommand));

const config = { commands: { codex: codexCommand, aiCodeControl: controlCommand } };
class ConsumerExecutor {
  async execute({ observation, workspacePath }) {
    const task = tasks.get(String(observation.taskId));
    if (!task) return { status: "BLOCKED", message: "Frozen task is unavailable." };
    const arm = String(observation.armId);
    const provider = armProviders.get(arm);
    const scaffolding = prepareWorkspace(workspacePath, observation, task, arm);
    try {
      if (task.expectedOutcome === "BLOCKED") return { status: "BLOCKED", message: "Unavailable production credential was not supplied; refusal is required.", metrics: zeroMetrics() };
      if (arm === "candidate") process.env.INFOAPEX_OTEL_ENABLED = "1";
      else delete process.env.INFOAPEX_OTEL_ENABLED;
      const adapter = arm === "direct" ? adapters.get(provider) : adapters.get("infoapex");
      const result = await adapter.execute(requestFor({ observation, workspacePath, task, arm, provider }));
      return { status: result.status === "DONE" ? "DONE" : "BLOCKED", message: result.message, metrics: { elapsedMs: result.timing.elapsedMs, providerLatencyMs: result.timing.elapsedMs, usage: result.usage, ...(result.candidateTelemetry ? { eligibleTraceCoverage: result.candidateTelemetry.eligibleTraceCoverage, telemetryLeakageCount: result.candidateTelemetry.telemetryLeakageCount } : {}) } };
    } finally {
      delete process.env.INFOAPEX_OTEL_ENABLED;
      cleanupWorkspaceScaffolding(workspacePath, scaffolding);
    }
  }
}

const runtime = await runExperiment({ experiment: experimentPath, repositoryPath: repo, stateRoot, executor: new ConsumerExecutor(), concurrency: 1, timeoutMs: 135000, maximumNewObservations: positive("--maximum-new-observations") });
const evaluated = await evaluateExperiment({ stateRoot, experimentId: String(experiment.id), suite });
const observations = evaluated.results.map((evaluation) => {
  const terminal = runtime.observations.find((item) => item.id === evaluation.observationId);
  return { taskId: evaluation.taskId, armId: String(terminal?.armId ?? "unknown"), repetition: Number(terminal?.repetition ?? 1), provider: armProviders.get(String(terminal?.armId)) ?? "unknown", environmentId: String(experiment.environment?.id ?? "unknown"), verdict: evaluation.verdict, evaluation, criticalSafetyFailure: evaluation.criticalSafetyFailure, scopeSafety: evaluation.scope.verdict === "PASS" ? 1 : 0, verifiedTaskSuccess: evaluation.verdict === "PASS" ? 1 : 0, firstPassSuccess: evaluation.verdict === "PASS" ? 1 : 0, humanActiveMinutes: 0, telemetry: terminal?.telemetry ?? null, experimentHash: experiment.experimentHash, protocolHash: experiment.protocolHash ?? suite.hash };
});
const candidateArm = experiment.arms.find((arm) => arm.kind === "candidate");
const report = buildBenchmarkReport(observations, { experimentId: String(experiment.id), experimentHash: experiment.experimentHash, protocolHash: experiment.protocolHash ?? suite.hash, providerByArm: Object.fromEntries(armProviders), environmentId: String(experiment.environment?.id ?? "unknown"), categories: Object.fromEntries(suite.tasks.map((task) => [String(task.value.id), String(task.value.kind)])), expectedObservationCount: experiment.arms.length * suite.tasks.length * Number(experiment.repetitions), baselineArmId: "full-icm", candidateArmId: String(candidateArm?.id ?? "candidate"), generatedAt: new Date().toISOString() });
const reportRoot = join(stateRoot, "benchmarks", String(experiment.id), "redacted"); mkdirSync(reportRoot, { recursive: true });
writeFileSync(join(reportRoot, "REPORT.json"), JSON.stringify(report, null, 2) + "\n", "utf8"); writeFileSync(join(reportRoot, "REPORT.md"), renderMarkdownReport(report), "utf8");
console.log(JSON.stringify({ status: report.verdict, runtime, evaluated: { count: evaluated.evaluated, skipped: evaluated.skipped }, report, reportRoot }, null, 2));

function requestFor({ observation, workspacePath, task, arm, provider }) {
  const prompt = String(task.prompt);
  const armSpec = experiment.arms.find((item) => String(item.id) === arm);
  if (!armSpec) throw new Error(`Consumer experiment does not define arm ${arm}.`);
  const base = { arm, repositoryPath: workspacePath, taskId: String(task.id), seed: Number(observation.seed), prompt, provider, model: String(armSpec.model ?? ""), effort: String(armSpec.effort ?? ""), permissions: { sandbox: codexSandbox, mode: "dontAsk", allowedTools: [] }, limits: { timeoutMs: Number(task.limits.timeoutSeconds) * 1000, maximumOutputBytes: Number(task.limits.maximumOutputBytes) }, environmentAllowlist: arm === "candidate" ? ["INFOAPEX_OTEL_ENABLED"] : [] };
  if (arm === "direct") return base;
  return { ...base, provider: "codex", orchestrationPlanPath: scaffoldingPlan(workspacePath, task), armConfiguration: { contextProvider: "ai-code-control", contextPackageMode: "enforce", ...(arm === "candidate" ? { candidateCapability: "opentelemetry-redacted-v1" } : {}) } };
}
function prepareWorkspace(workspace, observation, task, arm) {
  const oldGitignore = existsSync(join(workspace, ".gitignore")) ? readFileSync(join(workspace, ".gitignore"), "utf8") : null;
  const plan = arm === "direct" ? null : scaffoldingPlan(workspace, task);
  if (arm !== "direct") {
    const armSpec = experiment.arms.find((item) => String(item.id) === arm);
    if (!armSpec) throw new Error(`Consumer experiment does not define arm ${arm}.`);
    const worker = join(workspace, ".ai-code-worker"); mkdirSync(worker, { recursive: true });
    writeFileSync(join(worker, "config.json"), JSON.stringify({ schemaVersion: "1.0", defaultEngine: "codex", contextProvider: "ai-code-control", contextPackage: { mode: "enforce", maximumTokens: 12000 }, stateRoot: join(workspace, "..", "worker-state", String(observation.id)), maximumParallelWriters: 1, maximumRepairCycles: 0, maximumRunMinutes: 3, executionEnvironment: { defaultProfile: "isolated", allowTrustedLocal: false }, syncRootPolicy: { sequentialWriter: "warn", parallelWriters: "block" }, adapters: { codex: { executable: codexCommand[0], baseArgs: codexCommand.slice(1), model: String(armSpec.model ?? ""), reasoningEffort: String(armSpec.effort ?? ""), sandboxMode: codexSandbox, timeoutSeconds: 120, maximumOutputBytes: 65536 }, aiCodeControl: { executable: controlCommand[0], baseArgs: controlCommand.slice(1), timeoutSeconds: 30, maximumOutputBytes: 1000000 } } }, null, 2) + "\n", "utf8");
    writeFileSync(join(workspace, ".gitignore"), ".ai-code-control/\n", "utf8");
    if (arm === "full-icm" || arm === "candidate") execFileSync(controlCommand[0], [...controlCommand.slice(1), "init", "--repo", workspace], { cwd: workspace, stdio: "ignore", windowsHide: true });
  }
  execFileSync("git", ["init", "--quiet"], { cwd: workspace, stdio: "ignore" }); execFileSync("git", ["-c", "user.name=benchmark", "-c", "user.email=benchmark@localhost", "add", "."], { cwd: workspace, stdio: "ignore" }); execFileSync("git", ["-c", "user.name=benchmark", "-c", "user.email=benchmark@localhost", "commit", "--quiet", "-m", "benchmark baseline"], { cwd: workspace, stdio: "ignore" });
  return { plan, oldGitignore };
}
function scaffoldingPlan(workspace, task) {
  const plan = join(workspace, "Plan", `consumer-${task.id}.md`); mkdirSync(join(workspace, "Plan"), { recursive: true });
  const prompt = String(task.prompt);
  const verification = Array.isArray(task.verification) ? task.verification[0] : null;
  const gateCommand = verification && Array.isArray(verification.command) && verification.command.every((part) => typeof part === "string" && part.length > 0) ? verification.command : null;
  if (!gateCommand) throw new Error(`Consumer task ${String(task.id)} has no valid verification command.`);
  const gateText = gateCommand.join(" ");
  const body = { workerContractVersion: "1.1", goal: prompt, tasks: [{ id: `CONSUMER-${String(task.id).toUpperCase()}`, kind: "backend", role: prompt, dependsOn: [], requiredInputs: [], allowedPaths: Array.isArray(task.scope?.allow) ? task.scope.allow : [], forbiddenPaths: [".git/**", ".infoapex-ai/**", "mockup/**", "*.env", "*.log"], expectedArtifacts: Array.isArray(task.scope?.allow) ? task.scope.allow : [], acceptanceCriteria: [prompt], verify: [gateText], traceability: { acceptanceCriteria: [{ criterionId: "AC-CONSUMER-01", text: prompt }], gates: [{ gateId: "G-CONSUMER-01", command: gateText, evidenceContract: "Consumer verification command passes.", criterionIds: ["AC-CONSUMER-01"] }] }, concurrencyKeys: [String(task.id)], risk: String(task.risk) }] };
  writeFileSync(plan, `---\nstatus: accepted\n---\n\n# EuroCarScan consumer task\n\n\`\`\`json ai-code-worker-plan\n${JSON.stringify(body, null, 2)}\n\`\`\`\n`, "utf8"); return plan;
}
function cleanupWorkspaceScaffolding(workspace, scaffolding) { removeTransientCaches(workspace); if (existsSync(join(workspace, ".git"))) rmSync(join(workspace, ".git"), { recursive: true, force: true }); if (existsSync(join(workspace, ".ai-code-worker"))) rmSync(join(workspace, ".ai-code-worker"), { recursive: true, force: true }); if (existsSync(join(workspace, ".ai-code-control"))) rmSync(join(workspace, ".ai-code-control"), { recursive: true, force: true }); if (scaffolding.plan && existsSync(scaffolding.plan)) rmSync(scaffolding.plan, { force: true }); if (scaffolding.oldGitignore === null) { if (existsSync(join(workspace, ".gitignore"))) rmSync(join(workspace, ".gitignore"), { force: true }); } else writeFileSync(join(workspace, ".gitignore"), scaffolding.oldGitignore, "utf8"); }
function removeTransientCaches(root) { for (const entry of readdirSync(root, { withFileTypes: true })) { const path = join(root, entry.name); if (entry.isDirectory() && ["__pycache__", ".pytest_cache", ".mypy_cache", ".ruff_cache"].includes(entry.name)) { rmSync(path, { recursive: true, force: true }); continue; } if (entry.isDirectory() && entry.name !== ".git") removeTransientCaches(path); } }
function zeroMetrics() { return { elapsedMs: 0, providerLatencyMs: 0, usage: { inputUncachedTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0, totalTokens: 0, costUsd: null } }; }
function assertFrozenRepositoryRevision(repository, loadedSuite) {
  const revisions = [...new Set([...loadedSuite.tasks].map((task) => task.value.initialState?.revision).filter((revision) => typeof revision === "string" && revision !== "0000000"))];
  if (revisions.length !== 1) throw new Error("Consumer suite must freeze exactly one repository revision.");
  const expected = revisions[0];
  const taskPaths = [...new Set([...loadedSuite.tasks].map((task) => task.value.initialState?.repository).filter((path) => typeof path === "string"))];
  let actual;
  try { actual = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repository, encoding: "utf8" }).trim(); }
  catch { throw new Error("Consumer benchmark repository must be a Git worktree at the frozen revision."); }
  if (actual.startsWith(expected)) return;
  try { execFileSync("git", ["merge-base", "--is-ancestor", expected, actual], { cwd: repository, stdio: "ignore" }); }
  catch { throw new Error(`Frozen consumer suite targets revision ${expected}, but repository is at ${actual}. Create a new suite and experiment revision after architecture changes.`); }
  for (const path of taskPaths) {
    try { execFileSync("git", ["diff", "--quiet", `${expected}..${actual}`, "--", path], { cwd: repository, stdio: "ignore" }); }
    catch { throw new Error(`Frozen consumer task baseline path ${path} changed after revision ${expected}. Create a new suite and experiment revision.`); }
  }
}
function provider() { return option("--provider") ?? "codex"; }
function option(name) { const index = process.argv.indexOf(name); return index >= 0 ? process.argv[index + 1] ?? null : null; }
function positive(name) { const value = option(name); if (value === null) return undefined; const number = Number(value); if (!Number.isSafeInteger(number) || number < 1) throw new Error(`${name} must be positive.`); return number; }
