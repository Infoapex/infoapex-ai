import { spawnSync, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";
import { writeFakeClaudeCli } from "../modules/ai-code-worker/dist/src/engines/claude-cli.js";
import { writeFakeCodexCli } from "../modules/ai-code-worker/dist/src/engines/codex-cli.js";
import { isAvailabilityFailure } from "../modules/ai-code-worker/dist/src/routing/task-execution.js";
import { assessUsageTotals } from "../modules/ai-code-worker/dist/src/usage/normalized-usage.js";
import { findCodexRolloutsModifiedSince, readCodexSessionLog } from "../modules/ai-code-worker/dist/src/benchmark/read-codex-session.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const workerRoot = join(root, "modules", "ai-code-worker");
const workerCli = join(workerRoot, "dist", "src", "cli.js");
const experimentPath = join(root, "validation", "p2-a", "experiment.json");
const schemaPath = join(root, "validation", "p2-a", "experiment.schema.json");
const live = process.argv.includes("--live");
const fixture = process.argv.includes("--fixture") || !live;
const outputPath = option("--out");
const timeoutMs = Number(process.env.APEX_P2A_TIMEOUT_MS ?? 600_000);

const experiment = JSON.parse(readFileSync(experimentPath, "utf8"));
validateExperiment(experiment);
const startedAt = new Date().toISOString();
const workspace = mkdtempSync(join(tmpdir(), "infoapex-p2-a-"));

try {
  const classification = classificationMatrix();
  const smokes = [];
  for (const task of experiment.tasks) {
    smokes.push(runSmoke(task));
  }
  const functionalPass = smokes.every((smoke) => smoke.status === "DONE" && smoke.doctorStatus === "PASS")
    && classification.every((entry) => entry.actual === entry.expected);
  const economicVerdict = smokes.every((smoke) => smoke.usageAssessment?.economicVerdict === "comparable")
    ? "comparable"
    : "inconclusive";
  const report = {
    schemaVersion: "1.0",
    experimentId: experiment.experimentId,
    mode: live ? "live" : "fixture",
    usageConsuming: live,
    startedAt,
    finishedAt: new Date().toISOString(),
    frozen: {
      sourceBaselineCommit: experiment.sourceBaselineCommit,
      graph06Enabled: experiment.graph06Enabled,
      maximumLiveInvocations: experiment.maximumLiveInvocations,
      taskGoalHashes: experiment.tasks.map((task) => task.goalSha256)
    },
    functionalVerdict: functionalPass ? "PASS" : "BLOCKED",
    economicVerdict,
    p2bReadiness: functionalPass ? (economicVerdict === "comparable" ? "READY" : "FUNCTIONAL_READY_ECONOMIC_PARTIAL") : "BLOCKED",
    classification,
    smokes
  };
  const text = `${JSON.stringify(report, null, 2)}\n`;
  if (outputPath) {
    const resolved = resolve(root, outputPath);
    mkdirSync(dirname(resolved), { recursive: true });
    writeFileSync(resolved, text, "utf8");
  }
  process.stdout.write(text);
  process.exitCode = functionalPass ? 0 : 2;
} finally {
  rmSync(workspace, { recursive: true, force: true });
}

function validateExperiment(value) {
  const schema = JSON.parse(readFileSync(schemaPath, "utf8"));
  const validate = new Ajv2020({ strict: true }).compile(schema);
  if (!validate(value)) throw new Error(`Invalid P2-A experiment: ${JSON.stringify(validate.errors)}`);
  if (value.tasks.length !== value.maximumLiveInvocations) throw new Error("P2-A task count exceeds frozen live invocation budget.");
  for (const task of value.tasks) {
    const digest = createHash("sha256").update(task.goal).digest("hex");
    if (digest !== task.goalSha256) throw new Error(`Goal hash drift for ${task.taskId}.`);
  }
}

function runSmoke(task) {
  const repository = createRepository(task);
  const provider = experiment.providers[task.engine];
  const executable = fixture ? createFixtureExecutable(task) : null;
  const doctorArgs = [workerCli, "doctor", "--repo", repository, "--engine", task.engine, "--json"];
  const runArgs = [workerCli, "run", "--repo", repository, "--plan", "Plan/P2-A.md", "--run-id", `p2-a-${task.engine}-${live ? "live" : "fixture"}`, "--engine", task.engine, "--json"];
  if (task.engine === "codex") {
    doctorArgs.push("--codex-model", provider.model, "--codex-sandbox", "danger-full-access");
    runArgs.push("--codex-model", provider.model, "--codex-sandbox", "danger-full-access");
    if (executable) doctorArgs.push("--codex-executable", executable), runArgs.push("--codex-executable", executable);
  } else {
    doctorArgs.push("--claude-model", provider.model, "--claude-permission-mode", "dontAsk");
    runArgs.push("--claude-model", provider.model, "--claude-permission-mode", "dontAsk");
    if (executable) doctorArgs.push("--claude-executable", executable), runArgs.push("--claude-executable", executable);
  }
  const doctor = runJson(process.execPath, doctorArgs, workerRoot);
  const executionStartedAt = new Date();
  const before = Date.now();
  const execution = runJson(process.execPath, runArgs, workerRoot);
  const executionFinishedAt = new Date();
  const elapsedMs = Date.now() - before;
  const runRoot = execution.body?.state?.runRoot;
  const runReport = runRoot ? readJsonOrNull(join(runRoot, "run-report.json")) : null;
  const rolloutFallback = task.engine === "codex" && runReport?.usageAssessment?.completeness === "unavailable"
    ? recoverCodexRolloutUsage(executionStartedAt, executionFinishedAt)
    : null;
  const usage = rolloutFallback?.usage ?? runReport?.usage ?? null;
  const usageAssessment = rolloutFallback ? assessUsageTotals(usage) : runReport?.usageAssessment ?? null;
  return {
    taskId: task.taskId,
    engine: task.engine,
    requestedModel: provider.model,
    requestedEffort: provider.effort,
    expectedCliVersion: provider.cliVersion,
    doctorStatus: doctor.body?.status ?? "BLOCKED",
    observedCliVersion: doctor.body?.engineDoctor?.parsedVersion ?? null,
    status: execution.body?.status ?? "BLOCKED",
    blockedReason: execution.body?.blockedReason ?? execution.body?.findings?.[0]?.message ?? runReport?.blockedReason ?? null,
    findings: execution.body?.findings ?? [],
    elapsedMs,
    runId: execution.body?.runId ?? execution.body?.state?.runId ?? null,
    engineProvenance: execution.body?.engineProvenance ?? null,
    usageSource: rolloutFallback ? "sanitized-local-rollout-fallback" : "worker-run-report",
    usage,
    usageAssessment,
    stderrTail: execution.stderr.slice(-500)
  };
}

function recoverCodexRolloutUsage(startedAt, finishedAt) {
  const candidates = findCodexRolloutsModifiedSince(startedAt, {}, finishedAt);
  for (const path of [...candidates].reverse()) {
    const summary = readCodexSessionLog(path);
    const total = summary?.totalTokenUsage;
    if (!total || total.inputTokens === null) continue;
    return {
      usage: {
        agentInvocations: 1,
        inputUncachedTokens: total.cachedInputTokens === null ? total.inputTokens : Math.max(0, total.inputTokens - total.cachedInputTokens),
        cacheReadTokens: total.cachedInputTokens,
        cacheWriteTokens: total.cacheWriteTokens,
        outputTokens: total.outputTokens,
        costUsd: null
      }
    };
  }
  return null;
}

function createRepository(task) {
  const repository = mkdtempSync(join(workspace, `${task.engine}-`));
  mkdirSync(join(repository, "Plan"), { recursive: true });
  mkdirSync(join(repository, "scripts"), { recursive: true });
  writeFileSync(join(repository, "README.md"), "# P2-A disposable smoke repository\n", "utf8");
  writeFileSync(join(repository, "scripts", "verify-smoke.mjs"), `import { readFileSync } from "node:fs";\nconst actual=readFileSync(process.argv[2],"utf8");\nif(actual!==process.argv[3]+"\\n") process.exit(1);\n`, "utf8");
  const body = {
    goal: task.goal,
    tasks: [{
      id: task.taskId,
      kind: "test",
      role: "p2-a-smoke-writer",
      dependsOn: [],
      requiredInputs: ["README.md"],
      allowedPaths: [task.expectedPath],
      forbiddenPaths: [".git/**"],
      expectedArtifacts: [task.expectedPath],
      acceptanceCriteria: [task.goal],
      verify: [`node scripts/verify-smoke.mjs ${task.expectedPath} "${task.expectedContent.trim()}"`],
      concurrencyKeys: ["p2-a-sequential"],
      risk: "low"
    }],
    globalGates: ["node -e \"process.exit(0)\""],
    budgets: {
      maximumParallelWriters: 1,
      maximumRepairCycles: 0,
      maximumTaskMinutes: 10,
      maximumRunMinutes: 15,
      maximumAgentInvocations: 1,
      maximumRunInputUncachedTokens: 500000,
      maximumRunCacheReadTokens: 1000000,
      maximumRunCacheWriteTokens: 500000,
      maximumRunOutputTokens: 100000,
      maximumRunCostUsd: null,
      onUnknownUsage: "allow"
    }
  };
  writeFileSync(join(repository, "Plan", "P2-A.md"), `---\nstatus: accepted\n---\n\n# P2-A ${task.engine} smoke\n\n\`\`\`json ai-code-worker-plan\n${JSON.stringify(body, null, 2)}\n\`\`\`\n`, "utf8");
  execFileSync("git", ["init", "--initial-branch", "main"], { cwd: repository, stdio: "ignore" });
  execFileSync("git", ["config", "user.name", "Infoapex P2-A"], { cwd: repository });
  execFileSync("git", ["config", "user.email", "p2-a@example.invalid"], { cwd: repository });
  execFileSync("git", ["add", "."], { cwd: repository, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "freeze P2-A smoke fixture"], { cwd: repository, stdio: "ignore" });
  const init = runJson(process.execPath, [workerCli, "init", "--repo", repository, "--json"], workerRoot);
  if (init.status !== 0) throw new Error(`Worker init failed for ${task.engine}: ${init.stderr || init.stdout}`);
  execFileSync("git", ["add", ".ai-code-worker"], { cwd: repository, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "add worker configuration"], { cwd: repository, stdio: "ignore" });
  return repository;
}

function createFixtureExecutable(task) {
  const script = join(workspace, `fake-${task.engine}.mjs`);
  if (task.engine === "codex") {
    writeFakeCodexCli(script, { version: experiment.providers.codex.cliVersion, touchedFile: task.expectedPath });
  } else {
    writeFakeClaudeCli(script, { version: experiment.providers.claude.cliVersion, touchedFile: task.expectedPath });
  }
  const generated = readFileSync(script, "utf8")
    .replace('fs.writeFileSync(touchedFile, "codex fake output\\n");', `fs.writeFileSync(touchedFile, ${JSON.stringify(task.expectedContent)});`)
    .replace('fs.writeFileSync(touchedFile, "claude fake output\\n");', `fs.writeFileSync(touchedFile, ${JSON.stringify(task.expectedContent)});`);
  writeFileSync(script, generated, "utf8");
  chmodSync(script, 0o755);
  if (process.platform !== "win32") return script;
  const wrapper = join(workspace, `fake-${task.engine}.cmd`);
  writeFileSync(wrapper, `@echo off\r\n"${process.execPath}" "${script}" %*\r\n`, "utf8");
  return wrapper;
}

function classificationMatrix() {
  return [
    classification("quota", "engine", "HTTP 429: rate limit exceeded", true),
    classification("sandbox", "engine", "Write access was rejected by the read-only sandbox.", true),
    classification("implementation", "deterministic", "TypeScript test failed", false)
  ];
}

function classification(label, failureClass, message, expected) {
  const execution = {
    result: { status: "FAILED", failures: [{ class: failureClass, message }] }
  };
  return { label, expected, actual: isAvailabilityFailure(execution) };
}

function runJson(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, encoding: "utf8", timeout: timeoutMs, windowsHide: true });
  let body = null;
  try { body = JSON.parse(result.stdout ?? ""); } catch {}
  return { status: result.status ?? 1, stdout: result.stdout ?? "", stderr: result.stderr ?? "", body };
}

function readJsonOrNull(path) {
  try { return JSON.parse(readFileSync(path, "utf8")); } catch { return null; }
}

function option(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] ?? null : null;
}
