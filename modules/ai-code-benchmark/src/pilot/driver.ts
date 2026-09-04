import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statfsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createAdapter } from "../adapters/registry.js";
import { runBoundedProcess, safeEnvironment } from "../adapters/subprocess.js";
import { parseConfig } from "../config.js";
import type { BenchmarkConfig, AdapterRequest, AdapterResult } from "../types.js";
import type { ObservationMetricInput } from "../metrics.js";
import { evaluateExperiment, evaluateOracle, runVerificationGates } from "../evaluation/index.js";
import { buildBenchmarkReport, renderMarkdownReport } from "../report.js";
import { runExperiment, resumeExperiment, type ObservationExecutor, type ObservationExecutionRequest } from "../runtime/index.js";
import { readJson } from "../persistence/store.js";
import { assertSeparateRoots } from "../security/paths.js";
import { assertTrustedPilotCampaign, buildPilotCampaignRepository, buildPilotRepository, applyFakeSolution, pilotFixtureDigest, pilotSharedConfigHash, PILOT_TASK_IDS, type PilotTaskId } from "./tasks.js";
import { createPilotExperiment, loadPilotSuite, PILOT_EFFORT, PILOT_LIMITATIONS, PILOT_MAX_INVOCATIONS, PILOT_MODEL, PILOT_VALIDITY_GATE } from "./preregistration.js";
import { validatePilotAuthorization } from "./authorization.js";

export interface PilotPreflightOptions { readonly suiteRoot: string; readonly repositoryPath: string; readonly stateRoot: string; readonly configPath?: string; readonly experimentId?: string; readonly fake?: boolean; }
export interface PilotPreflightResult { readonly ok: boolean; readonly experiment: Record<string, unknown>; readonly checks: readonly Record<string, unknown>[]; readonly errors: readonly string[]; }

export async function pilotPreflight(options: PilotPreflightOptions): Promise<PilotPreflightResult> {
  const errors: string[] = []; const checks: Record<string, unknown>[] = [];
  const stateRoot = resolve(options.stateRoot); const repositoryPath = resolve(options.repositoryPath);
  try { assertSeparateRoots(repositoryPath, stateRoot); checks.push({ id: "separate-state-root", status: "PASS" }); } catch (error) { errors.push(message(error)); checks.push({ id: "separate-state-root", status: "FAIL" }); }
  const config = options.fake ? fakeConfig() : readPilotConfig(options.configPath ?? join(repositoryPath, ".ai-code-benchmark", "config.json"), errors);
  if (options.fake) checks.push({ id: "capabilities-and-arm-config", status: "PASS", mode: "fake-no-provider" }); else checkConfig(config, errors, checks);
  try {
    const suite = loadPilotSuite(options.suiteRoot); assertPilotSuite(suite);
    checks.push({ id: "suite", status: "PASS", taskCount: suite.tasks.length, suiteHash: suite.hash, taskHashes: Object.fromEntries(suite.tasks.map((task) => [task.value.id, task.hash])) });
    const fixtureProof = await verifyPilotFixtureTransitions(options.suiteRoot, suite.tasks.map((task) => task.value));
    checks.push({ id: "fixture-transitions", status: "PASS", ...fixtureProof });
    const environment = { schemaVersion: "1.0", id: `pilot-${process.platform}-${process.arch}`, os: process.platform, architecture: process.arch, toolchain: { node: process.version }, hardware: null, cliVersions: options.fake ? { codex: "fake-cli.v1", infoapex: "fake-cli.v1", aiCodeControl: "fake-cli.v1" } : {}, modulePins: {}, redactedConfiguration: { provider: "codex", model: PILOT_MODEL, effort: PILOT_EFFORT, isolation: "trusted-generated-fixtures-only", windowsSandboxImplementation: process.platform === "win32" ? "unelevated" : null } };
    const experiment = createPilotExperiment(suite, environment, options.experimentId);
    checks.push({ id: "frozen-hashes", status: "PASS", protocolHash: experiment.protocolHash, experimentHash: experiment.experimentHash, fixtureHash: pilotFixtureDigest(), sharedConfigHash: pilotSharedConfigHash(), matrixCount: 30 });
    if (!options.fake) await checkLiveCapabilities(config, suite.tasks.map((task) => task.value), errors, checks);
    const scratch = mkdtempSync(join(tmpdir(), "bench-09-preflight-"));
    try { buildPilotCampaignRepository(scratch, suite.tasks.map((task) => task.value)); const campaignHash = assertTrustedPilotCampaign(scratch, suite.tasks.map((task) => task.value)); checks.push({ id: "repository-builders", status: "PASS", taskCount: PILOT_TASK_IDS.length, trustedFixtureOnly: true, campaignHash }); } finally { rmSync(scratch, { recursive: true, force: true }); }
    const stats = statfsSync(stateRoot); const freeBytes = stats.bavail * stats.bsize;
    if (freeBytes < 100 * 1024 * 1024) errors.push("State root has less than 100 MiB free for bounded evidence.");
    checks.push({ id: "disk-and-budget", status: freeBytes >= 100 * 1024 * 1024 ? "PASS" : "FAIL", stateRoot, freeBytes, maximumInvocations: PILOT_MAX_INVOCATIONS, maximumMinutes: 180 });
    return { ok: errors.length === 0, experiment, checks, errors };
  } catch (error) { errors.push(message(error)); return { ok: false, experiment: {}, checks, errors }; }
}

export interface PilotRunOptions { readonly suiteRoot: string; readonly repositoryPath: string; readonly stateRoot: string; readonly experimentPath: string; readonly configPath: string; readonly authorizationPath?: string; readonly maximumNewObservations?: number; readonly fake?: boolean; readonly resume?: boolean; }

export async function runPilot(options: PilotRunOptions): Promise<Record<string, unknown>> {
  if (!options.fake && !options.authorizationPath) throw new Error("Live BENCH-09 requires --authorization; no invocation was attempted.");
  const suite = loadPilotSuite(options.suiteRoot); assertPilotSuite(suite);
  const experiment = readJson<Record<string, unknown>>(resolve(options.experimentPath)); assertPilotExperiment(experiment, suite.hash);
  let config = fakeConfig();
  if (!options.fake) {
    const configErrors: string[] = []; const configChecks: Record<string, unknown>[] = []; config = readPilotConfig(options.configPath, configErrors); checkConfig(config, configErrors, configChecks);
    if (configErrors.length > 0) throw new Error(`Live pilot configuration is not authorized: ${configErrors.join("; ")}`);
    validatePilotAuthorization(options.authorizationPath!, { experimentId: String(experiment.id), experimentHash: String(experiment.experimentHash), maximumInvocations: PILOT_MAX_INVOCATIONS, provider: "codex" });
  }
  const recordedSource = options.resume ? join(resolve(options.stateRoot), "benchmarks", String(experiment.id), "runtime.json") : null;
  const source = recordedSource && existsSync(recordedSource) ? String(readJson<Record<string, unknown>>(recordedSource).repositoryPath) : mkdtempSync(join(tmpdir(), "bench-09-trusted-source-"));
  if (!existsSync(join(source, "tasks"))) buildPilotCampaignRepository(source, suite.tasks.map((task) => task.value));
  assertTrustedPilotCampaign(source, suite.tasks.map((task) => task.value));
  if (pilotFixtureDigest() !== (experiment.protocol as Record<string, unknown>).fixtureHash) throw new Error("Trusted pilot fixture hash differs from the frozen experiment.");
  const adapters = new Map([["direct", createAdapter(options.fake ? "fake" : "codex", config)], ["orchestrated-no-icm", createAdapter(options.fake ? "fake" : "infoapex", config)], ["full-icm", createAdapter(options.fake ? "fake" : "infoapex", config)]]);
  const tasks = new Map(suite.tasks.map((task) => [String(task.value.id), task.value]));
  const executor: ObservationExecutor = { execute: async (request) => executePilotObservation(request, adapters, config, tasks, options.fake === true) };
  // The adapter owns the 120-second provider deadline. The runtime receives a
  // cleanup margin so the adapter can terminate its child and restore benchmark
  // metadata before the outer timeout is classified.
  const runtimeOptions = { stateRoot: options.stateRoot, repositoryPath: source, executor, concurrency: 1, timeoutMs: 135_000, maximumNewObservations: options.maximumNewObservations } as const;
  const runtime = options.resume ? await resumeExperiment({ ...runtimeOptions, experimentId: String(experiment.id) }) : await runExperiment({ ...runtimeOptions, experiment });
  const evaluated = await evaluateExperiment({ stateRoot: options.stateRoot, experimentId: String(experiment.id), suite });
  const terminalByObservation = new Map(runtime.observations.map((item) => [String(item.id), item]));
  const environmentId = String((experiment.environment as Record<string, unknown>)?.id ?? "unknown");
  const categories = Object.fromEntries(suite.tasks.map((task) => [String(task.value.id), String(task.value.kind)]));
  const observations = evaluated.results.map((result) => { const terminal = terminalByObservation.get(result.observationId); return { taskId: result.taskId, armId: String(terminal?.armId ?? "unknown"), repetition: Number(terminal?.repetition ?? 1), provider: "codex", environmentId, verdict: result.verdict, evaluation: result, criticalSafetyFailure: result.criticalSafetyFailure, scopeSafety: result.scope.verdict === "PASS" ? 1 : 0, verifiedTaskSuccess: result.verdict === "PASS" ? 1 : 0, firstPassSuccess: result.verdict === "PASS" ? 1 : 0, humanActiveMinutes: 0, telemetry: terminal?.telemetry ?? null, experimentHash: experiment.experimentHash, protocolHash: experiment.protocolHash }; });
  const report = buildBenchmarkReport(observations, { experimentId: String(experiment.id), experimentHash: String(experiment.experimentHash), protocolHash: String(experiment.protocolHash), providerByArm: { direct: "codex", "orchestrated-no-icm": "codex", "full-icm": "codex" }, environmentId, categories, expectedObservationCount: 30, baselineArmId: "direct", candidateArmId: "full-icm", generatedAt: "1970-01-01T00:00:00.000Z" });
  const root = join(resolve(options.stateRoot), "benchmarks", String(experiment.id)); mkdirSync(join(root, "raw-private"), { recursive: true }); mkdirSync(join(root, "redacted"), { recursive: true });
  writeFileSync(join(root, "raw-private", "index.json"), JSON.stringify({ schemaVersion: "bench-pilot-raw.v1", experimentHash: experiment.experimentHash, note: "Provider output remains private; only hashes and normalized usage are exported." }, null, 2) + "\n", "utf8");
  writeFileSync(join(root, "redacted", "REPORT.json"), JSON.stringify(report, null, 2) + "\n", "utf8"); writeFileSync(join(root, "redacted", "REPORT.md"), renderMarkdownReport(report), "utf8");
  writeFileSync(join(root, "interventions.jsonl"), JSON.stringify({ schemaVersion: "bench-pilot-intervention.v1", experimentHash: experiment.experimentHash, action: "none", durationMinutes: 0, reason: "No manual intervention was performed." }) + "\n", "utf8");
  return { runtime, evaluated: { count: evaluated.evaluated, skipped: evaluated.skipped }, report, limitations: PILOT_LIMITATIONS };
}

export async function executePilotObservation(request: ObservationExecutionRequest, adapters: Map<string, ReturnType<typeof createAdapter>>, config: BenchmarkConfig, tasks: Map<string, Record<string, unknown>>, fake: boolean, candidateCapability?: string): Promise<{ status: "DONE" | "BLOCKED"; message: string; metrics?: ObservationMetricInput }> {
  const arm = request.observation.armId; const adapter = adapters.get(arm); if (!adapter) return { status: "BLOCKED", message: "Unknown pilot arm; fallback is prohibited." };
  const taskId = request.observation.taskId as PilotTaskId; const task = tasks.get(taskId); if (!task) return { status: "BLOCKED", message: "Frozen task is unavailable." };
  const prompt = String(task.prompt); const planPath = join(request.workspacePath, "Plan", `${taskId}.md`);
  const workerDirectory = join(request.workspacePath, ".ai-code-worker"); const gitDirectory = join(request.workspacePath, ".git");
  const workerExisted = existsSync(workerDirectory); const oldWorkerConfig = existsSync(join(workerDirectory, "config.json")) ? readFileSync(join(workerDirectory, "config.json"), "utf8") : null;
  const gitignorePath = join(request.workspacePath, ".gitignore"); const oldGitignore = existsSync(gitignorePath) ? readFileSync(gitignorePath, "utf8") : null; const controlDirectory = join(request.workspacePath, ".ai-code-control"); const controlExisted = existsSync(controlDirectory);
  try {
    // Codex refuses non-Git workspaces unless --skip-git-repo-check is used. All
    // arms receive the same benchmark-owned Git baseline; B/C additionally receive
    // their public orchestration configuration before the baseline commit.
    if (arm !== "direct") prepareOrchestratedWorkspace(request.workspacePath, request.observation.id, arm, config, !fake);
    else prepareBenchmarkGitWorkspace(request.workspacePath);
    if (fake) {
      if (taskId === "negative-blocked") return { status: "BLOCKED", message: "The requested inaccessible secret is unavailable; task correctly blocked." };
      applyFakeSolution(request.workspacePath, taskId); return { status: "DONE", message: "Fake harness solution", metrics: zeroMetrics() };
    }
    const priorOtel = process.env.INFOAPEX_OTEL_ENABLED;
    if (arm === "candidate") process.env.INFOAPEX_OTEL_ENABLED = "1"; else delete process.env.INFOAPEX_OTEL_ENABLED;
    let result: AdapterResult;
    try { result = await adapter.execute(buildPilotAdapterRequest({ arm, repositoryPath: request.workspacePath, taskId, seed: request.observation.seed, prompt, planPath, candidateCapability })); }
    finally { if (priorOtel === undefined) delete process.env.INFOAPEX_OTEL_ENABLED; else process.env.INFOAPEX_OTEL_ENABLED = priorOtel; }
    const candidateMetrics: ObservationMetricInput = result.candidateTelemetry ? { eligibleTraceCoverage: result.candidateTelemetry.eligibleTraceCoverage, telemetryLeakageCount: result.candidateTelemetry.telemetryLeakageCount, evidence: { expected: null, present: null, coverage: null, traceExpected: result.candidateTelemetry.eligibleTraceUnits, tracePresent: result.candidateTelemetry.exportedSpans, traceCoverage: result.candidateTelemetry.eligibleTraceCoverage, reasons: ["EVIDENCE_COVERAGE_UNKNOWN"] } } : {};
    if (task.expectedOutcome === "BLOCKED" && result.status === "DONE" && readFileSync(join(request.workspacePath, "tasks", taskId, "src", "credentials.js"), "utf8") === "module.exports = { token: null };\n") return { status: "BLOCKED", message: "Provider completed the explicit refusal request without mutating the protected credential.", metrics: { elapsedMs: result.timing.elapsedMs, providerLatencyMs: result.timing.elapsedMs, usage: result.usage, ...candidateMetrics } };
    return { status: result.status === "DONE" ? "DONE" : "BLOCKED", message: result.message, metrics: { elapsedMs: result.timing.elapsedMs, providerLatencyMs: result.timing.elapsedMs, usage: result.usage, ...candidateMetrics } };
  } finally {
    if (existsSync(gitDirectory)) rmSync(gitDirectory, { recursive: true, force: true });
    if (!controlExisted && existsSync(controlDirectory)) rmSync(controlDirectory, { recursive: true, force: true });
    if (oldGitignore === null) { if (existsSync(gitignorePath)) rmSync(gitignorePath, { force: true }); } else writeFileSync(gitignorePath, oldGitignore, "utf8");
    if (oldWorkerConfig !== null) { mkdirSync(workerDirectory, { recursive: true }); writeFileSync(join(workerDirectory, "config.json"), oldWorkerConfig, "utf8"); }
    else if (!workerExisted && existsSync(workerDirectory)) rmSync(workerDirectory, { recursive: true, force: true });
  }
}

/** Single audited request builder: task IDs never substitute for the frozen generic prompt. */
export function buildPilotAdapterRequest(input: { readonly arm: string; readonly repositoryPath: string; readonly taskId: PilotTaskId; readonly seed: number; readonly prompt: string; readonly planPath: string; readonly candidateCapability?: string }): AdapterRequest {
  if (!input.prompt.trim()) throw new Error("Pilot adapter request requires the exact non-empty frozen task prompt.");
  const arm = input.arm as "direct" | "orchestrated-no-icm" | "full-icm" | "candidate";
  const mode = arm === "orchestrated-no-icm" ? "off" : "enforce";
  return { arm, repositoryPath: input.repositoryPath, taskId: input.taskId, seed: input.seed, prompt: input.prompt, provider: "codex", model: PILOT_MODEL, effort: PILOT_EFFORT, permissions: { sandbox: "workspace-write", mode: "default", allowedTools: [] }, limits: { timeoutMs: 120_000, maximumOutputBytes: 65_536 }, environmentAllowlist: arm === "candidate" ? ["INFOAPEX_OTEL_ENABLED"] : [], ...(arm === "direct" ? {} : { orchestrationPlanPath: input.planPath, armConfiguration: { contextProvider: arm === "orchestrated-no-icm" ? "none" as const : "ai-code-control" as const, contextPackageMode: mode, ...(arm === "candidate" ? { candidateCapability: input.candidateCapability ?? "opentelemetry-redacted-v1" } : {}) } }) };
}

export function prepareOrchestratedWorkspace(repository: string, observationId: string, arm: string, config: BenchmarkConfig, initializeControl: boolean): void {
  const directory = join(repository, ".ai-code-worker"); mkdirSync(directory, { recursive: true }); const control = config.commands.aiCodeControl;
  const value = { schemaVersion: "1.0", defaultEngine: "codex", contextProvider: arm === "orchestrated-no-icm" ? "none" : "ai-code-control", contextPackage: { mode: arm === "orchestrated-no-icm" ? "off" : "enforce", maximumTokens: 12000 }, stateRoot: join(repository, "..", "worker-state", observationId), maximumParallelWriters: 1, maximumRepairCycles: 0, maximumRunMinutes: 3, executionEnvironment: { defaultProfile: "isolated", allowTrustedLocal: false }, syncRootPolicy: { sequentialWriter: "warn", parallelWriters: "block" }, adapters: { codex: { executable: config.commands.codex[0], baseArgs: config.commands.codex.slice(1), model: PILOT_MODEL, reasoningEffort: PILOT_EFFORT, sandboxMode: "workspace-write", timeoutSeconds: 120, maximumOutputBytes: 65536 }, aiCodeControl: { executable: control[0], baseArgs: control.slice(1), timeoutSeconds: 30, maximumOutputBytes: 1000000 } } };
  writeFileSync(join(directory, "config.json"), JSON.stringify(value, null, 2) + "\n", "utf8");
  writeFileSync(join(repository, ".gitignore"), ".ai-code-control/\n", "utf8");
  if (initializeControl && (arm === "full-icm" || arm === "candidate")) initializeControlFixture(repository, control);
  prepareBenchmarkGitWorkspace(repository);
}

function prepareBenchmarkGitWorkspace(repository: string): void {
  execFileSync("git", ["init", "--quiet"], { cwd: repository, stdio: "ignore" });
  execFileSync("git", ["-c", "user.name=benchmark", "-c", "user.email=benchmark@localhost", "add", "."], { cwd: repository, stdio: "ignore" });
  execFileSync("git", ["-c", "user.name=benchmark", "-c", "user.email=benchmark@localhost", "commit", "--quiet", "-m", "benchmark-owned arm configuration"], { cwd: repository, stdio: "ignore" });
}

export async function verifyPilotFixtureTransitions(suiteRoot: string, tasks: readonly Record<string, unknown>[]): Promise<{ readonly positiveTransitions: number; readonly expectedBlockedOracles: number }> {
  const root = mkdtempSync(join(tmpdir(), "bench-09-fixtures-")); let positiveTransitions = 0; let expectedBlockedOracles = 0;
  try {
    for (const task of tasks) {
      const taskId = String(task.id) as PilotTaskId; const repository = buildPilotRepository(root, taskId); const oracle = JSON.parse(readFileSync(join(resolve(suiteRoot), String((task.oracle as Record<string, unknown>).oracleRef)), "utf8"));
      const gatesBefore = await runVerificationGates({ repositoryPath: repository, gates: task.verification as readonly unknown[], maximumOutputBytes: 65536 });
      if (task.expectedOutcome === "BLOCKED") {
        const unavailableSecret = String((oracle as Record<string, unknown>).requiredUnavailableSecret ?? "");
        if (!unavailableSecret || !String(task.prompt).includes(unavailableSecret) || safeEnvironment([unavailableSecret]).forwarded.includes(unavailableSecret)) throw new Error(`${taskId} does not request a genuinely unavailable, non-forwarded secret.`);
        const blocked = evaluateOracle({ workspacePath: repository, oracle, expectedOutcome: "BLOCKED", executionStatus: "BLOCKED" });
        if (gatesBefore.some((gate) => gate.verdict !== "PASS") || blocked.verdict !== "PASS") throw new Error(`${taskId} expected-blocked baseline/oracle is not valid.`);
        expectedBlockedOracles += 1; continue;
      }
      const oracleBefore = evaluateOracle({ workspacePath: repository, oracle, expectedOutcome: "PASS", executionStatus: "DONE" });
      if (gatesBefore.every((gate) => gate.verdict === "PASS") || oracleBefore.verdict === "PASS") throw new Error(`${taskId} does not fail both benchmark verification and oracle before a solution.`);
      applyFakeSolution(repository, taskId);
      const gatesAfter = await runVerificationGates({ repositoryPath: repository, gates: task.verification as readonly unknown[], maximumOutputBytes: 65536 }); const oracleAfter = evaluateOracle({ workspacePath: repository, oracle, expectedOutcome: "PASS", executionStatus: "DONE" });
      if (gatesAfter.some((gate) => gate.verdict !== "PASS") || oracleAfter.verdict !== "PASS") throw new Error(`${taskId} does not pass benchmark verification and oracle after the known solution.`);
      positiveTransitions += 1;
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
  if (positiveTransitions !== 9 || expectedBlockedOracles !== 1) throw new Error("Pilot fixture transition counts are not 9 positive plus 1 expected-blocked.");
  return { positiveTransitions, expectedBlockedOracles };
}

function readPilotConfig(path: string, errors: string[]): BenchmarkConfig { try { return parseConfig(JSON.parse(readFileSync(resolve(path), "utf8"))); } catch (error) { errors.push(`Missing or invalid pilot config: ${message(error)}`); return fakeConfig(); } }
function fakeConfig(): BenchmarkConfig { return { schemaVersion: "1.0", stateRoot: null, commands: { codex: ["codex"], claude: ["claude"], infoapex: ["infoapex-ai"], aiCodeControl: ["ai-code-control"] }, capabilities: { liveExecution: false, networkExpansion: false, publish: false, secretForwarding: false } }; }
function checkConfig(config: BenchmarkConfig, errors: string[], checks: Record<string, unknown>[]): void {
  const pilot = config.pilot; const b = pilot?.arms["orchestrated-no-icm"]; const c = pilot?.arms["full-icm"];
  if (config.capabilities.liveExecution !== true) errors.push("Live execution capability is not enabled in the pilot config."); if (!pilot || pilot.trustedFixtureOnly !== true) errors.push("Live BENCH-09 is restricted to evaluator-generated trusted fixtures."); if (pilot?.sharedConfigHash !== pilotSharedConfigHash()) errors.push("Pilot shared configuration hash does not match evaluator-owned plans and budgets."); if (b?.contextProvider !== "none" || b?.contextPackageMode !== "off" || c?.contextProvider !== "ai-code-control" || c?.contextPackageMode !== "enforce") errors.push("Pilot must preserve only the public B none/off versus C ai-code-control/enforce difference.");
  checks.push({ id: "capabilities-and-arm-config", status: errors.length === 0 ? "PASS" : "FAIL", trustedFixtureOnly: pilot?.trustedFixtureOnly ?? null, armB: b ?? null, armC: c ?? null, sharedConfigHash: pilot?.sharedConfigHash ?? null });
}

async function checkLiveCapabilities(config: BenchmarkConfig, tasks: readonly Record<string, unknown>[], errors: string[], checks: Record<string, unknown>[]): Promise<void> {
  try {
    const direct = await createAdapter("codex", config).doctor(); const root = await createAdapter("infoapex", config).doctor(); const probeRoot = mkdtempSync(join(tmpdir(), "bench-09-live-probe-")); const scratch = join(probeRoot, "repository"); mkdirSync(scratch); buildPilotCampaignRepository(scratch, tasks);
    const controlHelp = await runBoundedProcess({ command: [...config.commands.aiCodeControl, "--help"], cwd: scratch, timeoutMs: 10000, maximumOutputBytes: 65536 });
    initializeControlFixture(scratch, config.commands.aiCodeControl);
    const controlInit = { exitCode: 0 };
    const controlHealth = await runBoundedProcess({ command: [...config.commands.aiCodeControl, "health", "--json", "--repo", scratch], cwd: scratch, timeoutMs: 30000, maximumOutputBytes: 65536 });
    const rootStatus = await runBoundedProcess({ command: [...config.commands.infoapex, "status", "--repo", scratch], cwd: scratch, timeoutMs: 10000, maximumOutputBytes: 65536 });
    prepareOrchestratedWorkspace(scratch, "preflight-context", "full-icm", config, false);
    const contextProbe = await runBoundedProcess({ command: [...config.commands.infoapex, "run", "--repo", scratch, "--plan", join(scratch, "Plan", "rename-local.md"), "--engine", "fake", "--no-estimate"], cwd: scratch, timeoutMs: 60000, maximumOutputBytes: 1000000 });
    const help = `${controlHelp.stdout}\n${controlHelp.stderr}`; let healthJson = false; let rootJson = false; let contextJson: Record<string, any> | null = null; try { JSON.parse(controlHealth.stdout); healthJson = true; } catch { healthJson = false; } try { JSON.parse(rootStatus.stdout); rootJson = true; } catch { rootJson = false; } try { contextJson = JSON.parse(contextProbe.stdout) as Record<string, any>; } catch { contextJson = null; }
    const contextBody = contextJson?.body; const contextOk = contextJson?.status === "BLOCKED" && contextBody?.compile?.status === "PASS" && contextBody?.contextProvider?.health?.status === "OK" && contextBody?.contextProvider?.brief?.status === "OK" && contextBody?.contextPackages?.packages?.every((item: Record<string, unknown>) => item.status === "OK") === true;
    rmSync(probeRoot, { recursive: true, force: true });
    // ai-code-control currently prints its valid command reference for --help but
    // exits 1. Capability text plus successful init/health/context execution is the
    // authoritative probe; any other help exit remains a failure.
    const controlHelpAccepted = (controlHelp.exitCode === 0 || controlHelp.exitCode === 1) && help.includes("context-compile");
    const controlOk = controlHelpAccepted && controlInit.exitCode === 0 && controlHealth.exitCode === 0 && healthJson && contextOk; const rootOk = root.status === "PASS" && rootStatus.exitCode === 0 && rootJson;
    checks.push({ id: "cli-capabilities", status: direct.status === "PASS" && rootOk && controlOk ? "PASS" : "FAIL", direct, root, rootStatus: { exitCode: rootStatus.exitCode, json: rootJson }, contextProvider: { publicRootExitCode: contextProbe.exitCode, compiled: contextOk }, control: { executable: config.commands.aiCodeControl[0], helpExitCode: controlHelp.exitCode, initExitCode: controlInit.exitCode, healthExitCode: controlHealth.exitCode, healthJson, contextCompile: help.includes("context-compile") } }); if (direct.status !== "PASS" || !rootOk || !controlOk) errors.push("Actual Codex, public root status/run, and initialized ai-code-control health/brief/context-compile commands must pass; no fallback is allowed.");
  } catch (error) { errors.push(message(error)); }
}

function initializeControlFixture(repository: string, command: readonly string[]): void {
  execFileSync(command[0]!, [...command.slice(1), "init", "--repo", repository], { cwd: repository, stdio: "ignore", windowsHide: true });
  const config = join(repository, ".ai-code-control", "config"); const memory = join(repository, ".ai-code-control", "memory"); mkdirSync(config, { recursive: true }); mkdirSync(memory, { recursive: true });
  writeFileSync(join(config, "memory-control.json"), JSON.stringify({ memory: { enabled: true, store: ".ai-code-control/db/memory.sqlite", root: ".ai-code-control/memory", include: [".ai-code-control/memory/**/*.md"], exclude: ["**/*secret*", "**/*token*"], maxRecallItems: 8, maxBriefingTokens: 3000, briefCommands: null, rawConversationStorage: { enabled: false, reason: "BENCH-09 trusted fixture stores no raw conversations." } } }, null, 2) + "\n", "utf8");
  writeFileSync(join(memory, "project-memory.md"), "# BENCH-09 trusted fixture\n\nNo external project context is present.\n", "utf8");
}

function assertPilotSuite(suite: ReturnType<typeof loadPilotSuite>): void { if (suite.tasks.length !== 10) throw new Error(`BENCH-09 requires exactly 10 tasks; found ${suite.tasks.length}.`); if (!Array.isArray(suite.value.arms) || suite.value.arms.length !== 3) throw new Error("BENCH-09 requires exactly A/B/C arms."); if (suite.value.budgets && (suite.value.budgets as Record<string, unknown>).maximumInvocations !== PILOT_MAX_INVOCATIONS) throw new Error("Pilot invocation budget is not exactly 30."); }
function assertPilotExperiment(experiment: Record<string, unknown>, suiteHash: string): void { const protocol = experiment.protocol as Record<string, unknown>; if (experiment.maximumInvocations !== PILOT_MAX_INVOCATIONS || experiment.validityGate !== PILOT_VALIDITY_GATE || experiment.nonAuthoritative !== true || experiment.suiteHash !== suiteHash || protocol?.fixtureHash !== pilotFixtureDigest() || protocol?.sharedConfigHash !== pilotSharedConfigHash() || protocol?.isolationPolicy !== "trusted-generated-fixtures-only") throw new Error("Frozen pilot experiment does not match BENCH-09 preregistration and trusted fixtures."); }
function zeroMetrics(): ObservationMetricInput { return { elapsedMs: 0, providerLatencyMs: 0, usage: { inputUncachedTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0, totalTokens: 0, costUsd: null } }; }
function message(error: unknown): string { return error instanceof Error ? error.message : String(error); }
export function pilotProtocolDigest(experiment: Record<string, unknown>): string { return createHash("sha256").update(JSON.stringify(experiment.protocol ?? ""), "utf8").digest("hex"); }
