import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

const apexRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const plannerRoot = join(apexRoot, "modules", "ai-code-planner");
const workerRoot = join(apexRoot, "modules", "ai-code-worker");
const plannerCli = join(plannerRoot, "dist", "src", "cli.js");
const workerCli = join(workerRoot, "dist", "src", "cli.js");
const live = process.argv.includes("--live");
const timeoutMs = Number(process.env.APEX_VALUE_GATE_TIMEOUT_MS ?? (live ? 60000 : 30000));

const taskSeeds = [
  { label: "contract", goal: "Validate a generic contract fixture", path: "src/contract-fixture.txt" },
  { label: "service", goal: "Validate a generic service fixture", path: "src/service-fixture.txt" },
  { label: "workflow", goal: "Validate a generic workflow fixture", path: "src/workflow-fixture.txt" }
];

function planFor(seed) {
  return {
    goal: seed.goal,
    tasks: [{
      id: `TASK-${seed.label.toUpperCase()}`,
      goal: seed.goal,
      acceptanceCriteria: [{ criterionId: "AC-001", text: "The fixture remains valid after implementation." }],
      gates: [{ gateId: "G-001", command: "node scripts/pass-gate.mjs", evidenceContract: "The target repository test command exits with code 0." }],
      dependsOn: [],
      scope: { allowedPaths: [seed.path], forbiddenPaths: [".git/**"] },
      requiredInputs: [{ kind: "file", ref: seed.path }]
    }]
  };
}

function run(command, args, cwd) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    timeout: timeoutMs,
    windowsHide: true
  });
  return {
    status: result.status ?? (result.error?.code === "ETIMEDOUT" ? 124 : 1),
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    timedOut: result.error?.code === "ETIMEDOUT"
  };
}

function runJson(command, args, cwd) {
  const result = run(command, args, cwd);
  let body = null;
  try {
    body = JSON.parse(result.stdout);
  } catch {
    // The report below contains the bounded stdout/stderr for diagnosis.
  }
  return { ...result, body };
}

function createFakeClaude(directory, plans) {
  const script = join(directory, "fake-claude.mjs");
  const source = `import { readFileSync } from "node:fs";
const prompt = readFileSync(0, "utf8");
const plans = ${JSON.stringify(plans)};
const key = Object.keys(plans).find((entry) => prompt.includes(entry));
if (!key) process.exit(2);
console.log(JSON.stringify({
  type: "result",
  subtype: "success",
  is_error: false,
  result: JSON.stringify(plans[key]),
  usage: { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
}));
`;
  writeFileSync(script, source, "utf8");
  if (process.platform === "win32") {
    const wrapper = join(directory, "fake-claude.cmd");
    writeFileSync(wrapper, `@echo off\r\n"${process.execPath}" "${script}" %*\r\n`, "utf8");
    return wrapper;
  }
  const wrapper = join(directory, "fake-claude");
  writeFileSync(wrapper, `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`, "utf8");
  chmodSync(wrapper, 0o755);
  return wrapper;
}

function createTargetRepository() {
  const repository = mkdtempSync(join(tmpdir(), "apex-value-gate-"));
  execFileSync("git", ["init", "--initial-branch", "main"], { cwd: repository, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "apex-gate@example.invalid"], { cwd: repository });
  execFileSync("git", ["config", "user.name", "Apex Value Gate"], { cwd: repository });
  mkdirSync(join(repository, "scripts"), { recursive: true });
  writeFileSync(join(repository, "scripts", "pass-gate.mjs"), "process.exit(0);\n", "utf8");
  for (const seed of taskSeeds) {
    const path = join(repository, seed.path);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${seed.label} fixture\\n`, "utf8");
  }
  execFileSync("git", ["add", "."], { cwd: repository, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "fixture baseline"], { cwd: repository, stdio: "ignore" });
  const init = run(process.execPath, [workerCli, "init", "--repo", repository, "--json"], workerRoot);
  if (init.status !== 0) throw new Error(`Worker fixture init failed: ${init.stderr || init.stdout}`);
  execFileSync("git", ["add", ".ai-code-worker"], { cwd: repository, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "add worker fixture configuration"], { cwd: repository, stdio: "ignore" });
  return repository;
}

function main() {
  const missing = [plannerCli, workerCli].filter((path) => {
    try { readFileSync(path); return false; } catch { return true; }
  });
  if (missing.length > 0) {
    console.error(JSON.stringify({ status: "BLOCKED", reason: "Build planner and worker before running the value gate.", missing }, null, 2));
    process.exitCode = 2;
    return;
  }

  const repository = createTargetRepository();
  const workspace = mkdtempSync(join(tmpdir(), "apex-value-gate-tools-"));
  const plans = Object.fromEntries(taskSeeds.map((seed) => [seed.goal, planFor(seed)]));
  const fakeClaude = live ? null : createFakeClaude(workspace, plans);
  const results = [];

  try {
    for (const seed of taskSeeds) {
      const draft = join(workspace, `${seed.label}.plan.json`);
      const proposeArgs = ["propose", `Build ${seed.goal} for value gate`, "--repo", repository, "--out", draft, "--no-context", "--json"];
      if (fakeClaude) proposeArgs.push("--claude-executable", fakeClaude);
      else proposeArgs.push("--claude-timeout-ms", String(timeoutMs));

      const proposed = runJson(process.execPath, [plannerCli, ...proposeArgs], plannerRoot);
      const inspected = proposed.body?.draftPath
        ? runJson(process.execPath, [plannerCli, "inspect", proposed.body.draftPath, "--json"], plannerRoot)
        : { status: 1, stdout: "", stderr: "draft missing", body: null, timedOut: false };

      let taskId = null;
      try {
        const plan = JSON.parse(readFileSync(draft, "utf8"));
        taskId = plan.tasks?.[0]?.id ?? null;
      } catch {
        // The proposal report captures the failure.
      }

      const planPath = join(repository, "Plan", `${seed.label}.md`);
      const compiled = taskId
        ? runJson(process.execPath, [plannerCli, "compile", draft, "--task-id", taskId, "--repo", repository, "--out", planPath, "--json"], plannerRoot)
        : { status: 1, stdout: "", stderr: "task id missing", body: null, timedOut: false };
      const workerArgs = ["run", "--engine", live ? "claude" : "fake", "--repo", repository, "--plan", planPath, "--run-id", `value-gate-${seed.label}`, "--json"];
      if (live && process.env.APEX_CLAUDE_EXECUTABLE) workerArgs.push("--claude-executable", process.env.APEX_CLAUDE_EXECUTABLE);
      if (live && process.env.APEX_CLAUDE_MODEL) workerArgs.push("--claude-model", process.env.APEX_CLAUDE_MODEL);
      if (live && process.env.APEX_CLAUDE_PERMISSION_MODE) workerArgs.push("--claude-permission-mode", process.env.APEX_CLAUDE_PERMISSION_MODE);
      const executed = compiled.body?.status === "DONE"
        ? runJson(process.execPath, [workerCli, ...workerArgs], workerRoot)
        : { status: 1, stdout: "", stderr: "compile did not pass", body: null, timedOut: false };

      const passed = proposed.status === 0 && proposed.body?.status === "DONE"
        && inspected.status === 0 && inspected.body?.schemaValid === true && inspected.body?.lintOk === true
        && compiled.status === 0 && compiled.body?.status === "DONE"
        && executed.status === 0 && executed.body?.status === "DONE";
      results.push({ label: seed.label, mode: live ? "live" : "internal", passed, proposal: summarize(proposed), inspect: summarize(inspected), compile: summarize(compiled), worker: summarize(executed) });
    }
  } finally {
    rmSync(repository, { recursive: true, force: true });
    rmSync(workspace, { recursive: true, force: true });
  }

  const passed = results.every((result) => result.passed);
  console.log(JSON.stringify({
    status: passed ? "PASS" : "BLOCKED",
    mode: live ? "live" : "internal",
    usageConsuming: live,
    results
  }, null, 2));
  process.exitCode = passed ? 0 : 2;
}

function summarize(result) {
  return {
    status: result.status,
    timedOut: result.timedOut,
    report: result.body,
    stderr: result.stderr.slice(-2000)
  };
}

main();
