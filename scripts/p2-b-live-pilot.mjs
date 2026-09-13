import { spawnSync, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";
import { writeFakeClaudeCli } from "../modules/ai-code-worker/dist/src/engines/claude-cli.js";
import { writeFakeCodexCli } from "../modules/ai-code-worker/dist/src/engines/codex-cli.js";
import { assessUsageTotals } from "../modules/ai-code-worker/dist/src/usage/normalized-usage.js";
import { findCodexRolloutsModifiedSince, readCodexSessionLog } from "../modules/ai-code-worker/dist/src/benchmark/read-codex-session.js";

// P2-B extends the frozen P2-A live-invocation harness from 2 to 10 real sequential
// tasks against ONE shared repository (todo.md: "bounded usage-consuming common ICM +
// Graph pilot on 10 real sequential tasks"). Each task requires the engine to read a
// contract + source file and report back structured facts about them (contract $id,
// exported function names) so "accuracy" is a script-verified, unambiguous PASS/FAIL,
// not an LLM self-report. --independent-review is intentionally never enabled here:
// it invokes a second real engine per task (cross-review), which would silently double
// the live-invocation budget past the frozen 10. "Retries" instead measures the
// already-built, already-live-validated doctor-level --fallback-engine mechanism.
//
// Token/usage fields analyzed here are NOT /usage or /context (both are Claude Code
// TUI-only slash-commands with no CLI/API surface — verified via `claude --help`; they
// report this *session's* account-level %5h/%week, not a single headless invocation).
// The real per-task source is `claude -p --output-format json`'s `usage` object
// (complete: input/cache-read/cache-write/output tokens + total_cost_usd) and, for
// Codex, the sanitized local rollout fallback (`~/.codex/sessions/**`) which is
// missing cache-write and cost on CLI 0.147.0 — both already proven live in P2-A.

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const workerRoot = join(root, "modules", "ai-code-worker");
const workerCli = join(workerRoot, "dist", "src", "cli.js");
const experimentPath = join(root, "validation", "p2-b", "experiment.json");
const schemaPath = join(root, "validation", "p2-b", "experiment.schema.json");
const live = process.argv.includes("--live");
const fixture = process.argv.includes("--fixture") || !live;
const outputPath = option("--out");
const timeoutMs = Number(process.env.APEX_P2B_TIMEOUT_MS ?? 600_000);

const experiment = JSON.parse(readFileSync(experimentPath, "utf8"));
validateExperiment(experiment);
const startedAt = new Date().toISOString();
// realpathSync.native: see the identical, fuller comment in docs-gate.mjs.
const workspace = realpathSync.native(mkdtempSync(join(tmpdir(), "infoapex-p2-b-")));
const emptyCodexSessionsDir = fixture ? mkdtempSync(join(workspace, "empty-codex-sessions-")) : null;

try {
  const repository = createRepository();
  const executables = fixture
    ? { codex: createFixtureExecutable("codex"), claude: createFixtureExecutable("claude") }
    : { codex: null, claude: null };

  const tasks = [];
  for (const task of experiment.tasks) {
    tasks.push(runTask(repository, task, executables));
  }

  const report = buildReport(tasks);
  const text = `${JSON.stringify(report, null, 2)}\n`;
  if (outputPath) {
    const resolved = resolve(root, outputPath);
    mkdirSync(dirname(resolved), { recursive: true });
    writeFileSync(resolved, text, "utf8");
  }
  process.stdout.write(text);
  process.exitCode = report.functionalVerdict === "PASS" ? 0 : 2;
} finally {
  rmSync(workspace, { recursive: true, force: true });
}

function validateExperiment(value) {
  const schema = JSON.parse(readFileSync(schemaPath, "utf8"));
  const validate = new Ajv2020({ strict: true }).compile(schema);
  if (!validate(value)) throw new Error(`Invalid P2-B experiment: ${JSON.stringify(validate.errors)}`);
  if (value.tasks.length !== value.maximumLiveInvocations) throw new Error("P2-B task count exceeds frozen live invocation budget.");
  for (const task of value.tasks) {
    const digest = createHash("sha256").update(task.goal).digest("hex");
    if (digest !== task.goalSha256) throw new Error(`Goal hash drift for ${task.taskId}.`);
    if (task.engine === task.fallbackEngine) throw new Error(`${task.taskId}: engine and fallbackEngine must differ.`);
  }
}

function createRepository() {
  const repository = mkdtempSync(join(workspace, "shared-"));
  execFileSync("git", ["init", "--initial-branch", "main"], { cwd: repository, stdio: "ignore" });
  execFileSync("git", ["config", "user.name", "Infoapex P2-B"], { cwd: repository });
  execFileSync("git", ["config", "user.email", "p2-b@example.invalid"], { cwd: repository });
  writeFileSync(join(repository, "README.md"), "# P2-B disposable shared pilot repository\n", "utf8");

  mkdirSync(join(repository, "src"), { recursive: true });
  mkdirSync(join(repository, "contracts"), { recursive: true });
  mkdirSync(join(repository, "scripts"), { recursive: true });
  for (let index = 1; index <= 5; index++) {
    writeFileSync(
      join(repository, "src", `pilot-${index}.ts`),
      `export function pilotTarget${index}(): number { return ${index}; }\nexport function pilotCaller${index}(): number { return pilotTarget${index}(); }\n`
    );
    writeFileSync(
      join(repository, "contracts", `pilot-${index}.schema.json`),
      `${JSON.stringify({ $schema: "https://json-schema.org/draft/2020-12/schema", $id: `contracts/pilot-${index}.schema.json`, title: `Pilot contract ${index}`, type: "object" }, null, 2)}\n`
    );
  }
  writeFileSync(join(repository, "scripts", "verify-pilot-evidence.mjs"), verifyEvidenceScript(), "utf8");

  execFileSync("git", ["add", "."], { cwd: repository, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "freeze P2-B shared pilot fixture"], { cwd: repository, stdio: "ignore" });

  const init = runJson(process.execPath, [workerCli, "init", "--repo", repository, "--engines", "codex,claude", "--json"], workerRoot);
  if (init.status !== 0) throw new Error(`Worker init failed: ${init.stderr || init.stdout}`);
  execFileSync("git", ["add", ".ai-code-worker"], { cwd: repository, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "add worker configuration"], { cwd: repository, stdio: "ignore" });
  return repository;
}

function verifyEvidenceScript() {
  return [
    'import { readFileSync } from "node:fs";',
    "const [, , evidencePath, expectedContractRef, ...expectedFunctions] = process.argv;",
    "let parsed;",
    "try { parsed = JSON.parse(readFileSync(evidencePath, \"utf8\")); }",
    "catch { console.error(\"evidence file is missing or not valid JSON\"); process.exit(1); }",
    "if (parsed.contractRef !== expectedContractRef) {",
    '  console.error(`contractRef mismatch: expected ${expectedContractRef}, got ${JSON.stringify(parsed.contractRef)}`);',
    "  process.exit(1);",
    "}",
    "const actual = Array.isArray(parsed.exportedFunctions) ? parsed.exportedFunctions : null;",
    "if (!actual || actual.length !== expectedFunctions.length || actual.some((name, index) => name !== expectedFunctions[index])) {",
    '  console.error(`exportedFunctions mismatch: expected ${JSON.stringify(expectedFunctions)}, got ${JSON.stringify(parsed.exportedFunctions)}`);',
    "  process.exit(1);",
    "}",
    "process.exit(0);",
    ""
  ].join("\n");
}

function writeTaskPlan(repository, task) {
  const suffix = task.taskId.slice(-2);
  const evidencePath = `pilot/evidence-${suffix}.json`;
  const srcFile = `src/pilot-${task.contractIndex}.ts`;
  const contractFile = `contracts/pilot-${task.contractIndex}.schema.json`;
  const body = {
    goal: task.goal,
    tasks: [{
      id: task.taskId,
      kind: "test",
      role: "p2-b-pilot-writer",
      dependsOn: [],
      requiredInputs: [srcFile, contractFile],
      allowedPaths: [evidencePath],
      forbiddenPaths: [".git/**", "src/**", "contracts/**"],
      expectedArtifacts: [evidencePath],
      acceptanceCriteria: [task.goal],
      verify: [`node scripts/verify-pilot-evidence.mjs ${evidencePath} ${task.expectedContractRef} ${task.expectedExportedFunctions.join(" ")}`],
      concurrencyKeys: ["p2-b-sequential"],
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
  const planPath = join(repository, "Plan", `${task.taskId}.md`);
  mkdirSync(dirname(planPath), { recursive: true });
  writeFileSync(planPath, `---\nstatus: accepted\n---\n\n# P2-B ${task.taskId}\n\n\`\`\`json ai-code-worker-plan\n${JSON.stringify(body, null, 2)}\n\`\`\`\n`, "utf8");
  execFileSync("git", ["add", `Plan/${task.taskId}.md`], { cwd: repository, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", `add plan ${task.taskId}`], { cwd: repository, stdio: "ignore" });
  return { evidencePath };
}

function runTask(repository, task, executables) {
  const { evidencePath } = writeTaskPlan(repository, task);
  const provider = experiment.providers[task.engine];
  const runArgs = [
    workerCli, "run", "--repo", repository, "--plan", `Plan/${task.taskId}.md`,
    "--run-id", `p2-b-${task.taskId.toLowerCase()}-${live ? "live" : "fixture"}`,
    "--engine", task.engine, "--fallback-engine", task.fallbackEngine, "--json"
  ];
  if (fixture) runArgs.push("--execution-backend", "fake");
  if (task.engine === "codex") {
    runArgs.push("--codex-model", provider.model, "--codex-sandbox", "danger-full-access");
    if (executables.codex) runArgs.push("--codex-executable", executables.codex);
    // Fixture mode must stay fully hermetic: without this, the worker's own
    // quota-percent lookup (report/run-report.ts) would read whatever real Codex
    // rollout history exists on the machine running this script, even though the
    // fake CLI never touches the real ~/.codex/sessions at all.
    if (fixture) runArgs.push("--codex-sessions-dir", emptyCodexSessionsDir);
  } else {
    runArgs.push("--claude-model", provider.model, "--claude-permission-mode", "dontAsk");
    if (executables.claude) runArgs.push("--claude-executable", executables.claude);
  }

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
  // runReport.quotaUsage is computed by ai-code-worker itself (report/run-report.ts)
  // independently of whether usageTotals/tokens were available - even when Codex's
  // exec --json omits usage entirely (forcing the token rollout-fallback below), the
  // worker's OWN separate rollout lookup already populated a real, measured quota
  // reading, so it is reused as-is rather than recomputed here.
  const quotaUsage = runReport?.quotaUsage ?? null;
  const usageAssessment = rolloutFallback ? assessUsageTotals(usage, quotaUsage) : runReport?.usageAssessment ?? null;

  const status = execution.body?.status ?? "BLOCKED";
  // Task work lands on a dedicated `aiw/task/<runId>/<taskId>/attempt-N` branch in a
  // separate worktree, never merged/checked out into the shared repository's main
  // working tree - reading evidencePath directly from `repository` would always miss.
  // `runReport.taskCommits[taskId]` gives the real commit sha regardless of which
  // branch is checked out, so `git show <sha>:<path>` reads the actual content.
  const taskCommit = runReport?.taskCommits?.[task.taskId] ?? null;
  const evidence = taskCommit ? readEvidenceAtCommit(repository, taskCommit, evidencePath) : null;
  const contentCorrect = Boolean(
    evidence
    && evidence.contractRef === task.expectedContractRef
    && Array.isArray(evidence.exportedFunctions)
    && evidence.exportedFunctions.length === task.expectedExportedFunctions.length
    && evidence.exportedFunctions.every((name, index) => name === task.expectedExportedFunctions[index])
  );
  const engineProvenance = execution.body?.engineProvenance ?? null;

  return {
    taskId: task.taskId,
    requestedEngine: task.engine,
    fallbackEngine: task.fallbackEngine,
    requestedModel: provider.model,
    status,
    accurate: status === "DONE" && contentCorrect,
    gatePassed: status === "DONE",
    contentIndependentlyVerified: contentCorrect,
    fallbackTriggered: engineProvenance?.engineFallbackTriggered ?? false,
    engineProvenance,
    blockedReason: execution.body?.blockedReason ?? execution.body?.findings?.[0]?.message ?? runReport?.blockedReason ?? null,
    elapsedMs,
    runId: execution.body?.runId ?? execution.body?.state?.runId ?? null,
    usageSource: rolloutFallback ? "sanitized-local-rollout-fallback" : "worker-run-report",
    usage,
    usageAssessment,
    quotaUsage,
    stderrTail: execution.stderr.slice(-500)
  };
}

function sum(values) {
  return values.reduce((total, value) => total + value, 0);
}

function totalUsageTokens(usage) {
  if (!usage) return { total: null, complete: false };
  const fields = [usage.inputUncachedTokens, usage.cacheReadTokens, usage.cacheWriteTokens, usage.outputTokens];
  const complete = fields.every((value) => value !== null && value !== undefined);
  const total = fields.reduce((sum, value) => sum + (typeof value === "number" ? value : 0), 0);
  return { total, complete };
}

function buildReport(tasks) {
  const byEngine = { codex: [], claude: [] };
  for (const task of tasks) byEngine[task.requestedEngine].push(task);

  const summarizeEngine = (entries, engine) => {
    const accurate = entries.filter((entry) => entry.accurate).length;
    const fallbacks = entries.filter((entry) => entry.fallbackTriggered).length;
    const tokenTotals = entries.map((entry) => totalUsageTokens(entry.usage));
    const uncachedContextTotal = entries.reduce((sum, entry) => sum + (entry.usage?.inputUncachedTokens ?? 0), 0);
    const elapsedMsTotal = entries.reduce((sum, entry) => sum + entry.elapsedMs, 0);
    const fiveHourPercents = entries.map((entry) => entry.quotaUsage?.fiveHour?.percent ?? null);
    const knownFiveHourPercents = fiveHourPercents.filter((percent) => percent !== null);
    // Claude: each task's %5h is independently ESTIMATED from that task's own tokens,
    // so summing across tasks is valid (same reasoning as summing token counts).
    // Codex: each task's %5h is a real, MEASURED, cumulative account-wide gauge at
    // that moment, not a per-task amount - summing would double-count everything
    // already reflected in the account's running total, so only first/last (the
    // observed range across this run) is reported, not a sum.
    // "mixed" (the overall, cross-engine group) deliberately reports only the known-
    // count: summing or range-ing across a gauge (Codex) and independent estimates
    // (Claude) in the same figure would misrepresent both. Per-engine summaries below
    // carry the actual sum/first-last figures.
    const quotaSummary =
      engine === "claude"
        ? {
            fiveHourPercentKnownCount: knownFiveHourPercents.length,
            fiveHourPercentSumEstimated: knownFiveHourPercents.length === entries.length ? sum(knownFiveHourPercents) : null
          }
        : engine === "codex"
          ? {
              fiveHourPercentKnownCount: knownFiveHourPercents.length,
              fiveHourPercentFirstMeasured: knownFiveHourPercents[0] ?? null,
              fiveHourPercentLastMeasured: knownFiveHourPercents.at(-1) ?? null
            }
          : { fiveHourPercentKnownCount: knownFiveHourPercents.length };
    return {
      tasks: entries.length,
      accurate,
      accuracyRate: entries.length ? accurate / entries.length : null,
      fallbacksTriggered: fallbacks,
      uncachedContextTotal,
      totalTokens: tokenTotals.every((entry) => entry.complete)
        ? tokenTotals.reduce((sum, entry) => sum + entry.total, 0)
        : null,
      totalTokensComplete: tokenTotals.every((entry) => entry.complete),
      elapsedMsTotal,
      quota: quotaSummary
    };
  };

  const functionalPass = tasks.every((task) => task.status === "DONE");
  const economicVerdict = tasks.every((task) => task.usageAssessment?.economicVerdict === "comparable")
    ? "comparable"
    : "inconclusive";

  return {
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
    summary: {
      overall: summarizeEngine(tasks, "mixed"),
      codex: summarizeEngine(byEngine.codex, "codex"),
      claude: summarizeEngine(byEngine.claude, "claude")
    },
    tasks,
    methodologyNote:
      "'accurate' requires both a worker DONE status (script-verified gate) and an " +
      "independent re-check of pilot/evidence-NN.json content by this script. " +
      "'fallbacksTriggered' counts doctor-level --fallback-engine activations " +
      "(quota/availability failure of the requested engine before the task started); " +
      "no repair-cycle retries are measured here because --independent-review is not " +
      "enabled (it would add a second live invocation per task, breaking the frozen " +
      "10-invocation budget). Wall-clock elapsedMs is used as the explanation-time " +
      "proxy: no installed CLI (verified via --help on claude 2.1.235 and codex " +
      "0.147.0) exposes a separate reasoning-only timer. /usage and /context are " +
      "Claude Code TUI-only session commands and are not applicable to headless " +
      "per-task invocations; they are intentionally not used here. " +
      "'economicVerdict' (2026-09-02 decision) is based on knowing each task's " +
      "5-hour quota-percent, not costUsd - both engines here run on flat-rate " +
      "($20/mo) subscriptions, where costUsd is frequently unavailable by design " +
      "(see docs/RELEASE-GATES.md) and would not have reflected real marginal cost " +
      "anyway. Codex's percent is measured directly from its rollout; Claude's is " +
      "estimated from real tokens via a calibrated tokens-per-point ratio (see " +
      "quota-usage.ts, claude-calibration.ts) - both count as comparable."
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

function createFixtureExecutable(engine) {
  const script = join(workspace, `fake-${engine}.mjs`);
  if (engine === "codex") {
    writeFakeCodexCli(script, { version: experiment.providers.codex.cliVersion });
  } else {
    writeFakeClaudeCli(script, { version: experiment.providers.claude.cliVersion });
  }
  // The stock fake CLI writes one fixed `touchedFile`, which is not used here (a fixed
  // path would violate each task's own `allowedPaths: [pilot/evidence-NN.json]`). Both
  // generators parse the real request envelope from stdin into `request` (matching the
  // real claudePrompt()/codex prompt shape: runId, taskId, requiredInputs, ...) right
  // before an empty `catch {}` - a stable anchor to inject per-task-correct evidence
  // derived from `request.taskId` / `request.requiredInputs`, not from a fixed string.
  const generated = readFileSync(script, "utf8").replace(
    "} catch {}",
    [
      "} catch {}",
      "try {",
      "  const suffix = String(request.taskId || \"\").slice(-2);",
      "  const required = Array.isArray(request.requiredInputs) ? request.requiredInputs : [];",
      "  const contractInput = required.find((p) => typeof p === \"string\" && p.startsWith(\"contracts/pilot-\"));",
      "  const kMatch = contractInput ? contractInput.match(/pilot-(\\d)/) : null;",
      "  const k = kMatch ? kMatch[1] : \"0\";",
      "  if (suffix) {",
      "    fs.mkdirSync(\"pilot\", { recursive: true });",
      "    fs.writeFileSync(`pilot/evidence-${suffix}.json`, JSON.stringify({ contractRef: `contracts/pilot-${k}.schema.json`, exportedFunctions: [`pilotTarget${k}`, `pilotCaller${k}`] }, null, 2) + \"\\n\");",
      "  }",
      "} catch {}"
    ].join("\n")
  );
  writeFileSync(script, generated, "utf8");
  chmodSync(script, 0o755);
  if (process.platform !== "win32") return script;
  const wrapper = join(workspace, `fake-${engine}.cmd`);
  writeFileSync(wrapper, `@echo off\r\n"${process.execPath}" "${script}" %*\r\n`, "utf8");
  return wrapper;
}

function runJson(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, encoding: "utf8", timeout: timeoutMs, windowsHide: true, maxBuffer: 20 * 1024 * 1024 });
  let body = null;
  try { body = JSON.parse(result.stdout ?? ""); } catch {}
  return { status: result.status ?? 1, stdout: result.stdout ?? "", stderr: result.stderr ?? "", body };
}

function readEvidenceAtCommit(repository, commitSha, evidencePath) {
  const result = spawnSync("git", ["show", `${commitSha}:${evidencePath}`], { cwd: repository, encoding: "utf8" });
  if (result.status !== 0) return null;
  try { return JSON.parse(result.stdout); } catch { return null; }
}

function readJsonOrNull(path) {
  try { return JSON.parse(readFileSync(path, "utf8")); } catch { return null; }
}

function option(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] ?? null : null;
}
