#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const moduleRoot = resolve(import.meta.dirname, "../../../modules/ai-code-benchmark");
const workerRoot = resolve(moduleRoot, "../ai-code-worker");
const { runBoundedProcess } = await import(pathToFileURL(join(moduleRoot, "dist/src/adapters/subprocess.js")).href);
const infoapex = process.argv.includes("--infoapex");
const doctorOnly = process.argv.includes("--doctor-only");
const compileOnly = process.argv.includes("--compile-only");
const repository = mkdtempSync(join(tmpdir(), "bench-09-provider-diagnostic-"));
const codexExecutable = option("--codex-executable") ?? process.env.BENCH09_CODEX_EXECUTABLE ?? "codex";
const codexCommand = process.platform === "win32"
  ? [codexExecutable, "--config", 'windows.sandbox="unelevated"']
  : [codexExecutable];
let command = [...codexCommand, "exec", "--json", "--sandbox", "workspace-write", "--model", "gpt-5.6-luna", "--config", "model_reasoning_effort=medium", "-"];
let stdin = "Reply with OK. Do not modify files.";
if (process.argv.includes("--worker-write")) {
  command = [...codexCommand, "exec", "--json", "--cd", repository, "--sandbox", "workspace-write", "--model", "gpt-5.6-luna", "--config", "model_reasoning_effort=medium", "-"];
  stdin = "Use apply_patch exactly once to create smoke.txt containing exactly OK followed by a newline. If that single patch fails, stop immediately and report the failure. Do not retry and do not run shell commands.";
}
if (infoapex) {
  const { buildPilotCampaignRepository } = await import(pathToFileURL(join(moduleRoot, "dist/src/pilot/tasks.js")).href);
  const { loadPilotSuite } = await import(pathToFileURL(join(moduleRoot, "dist/src/pilot/preregistration.js")).href);
  const suite = loadPilotSuite(import.meta.dirname);
  buildPilotCampaignRepository(repository, suite.tasks.map((task) => task.value));
  const workerDirectory = join(repository, ".ai-code-worker");
  mkdirSync(workerDirectory, { recursive: true });
  writeFileSync(join(workerDirectory, "config.json"), `${JSON.stringify({
    schemaVersion: "1.0",
    defaultEngine: "codex",
    contextProvider: "none",
    contextPackage: { mode: "off", maximumTokens: 12000 },
    stateRoot: join(repository, "..", "worker-state"),
    maximumParallelWriters: 1,
    maximumRepairCycles: 0,
    maximumRunMinutes: 3,
    executionEnvironment: { defaultProfile: "isolated", allowTrustedLocal: false },
    syncRootPolicy: { sequentialWriter: "warn", parallelWriters: "block" },
    adapters: { codex: { executable: codexCommand[0], baseArgs: codexCommand.slice(1), model: "gpt-5.6-luna", reasoningEffort: "medium", sandboxMode: "workspace-write", timeoutSeconds: 120, maximumOutputBytes: 65536 } }
  }, null, 2)}\n`, "utf8");
  command = doctorOnly
    ? [process.execPath, resolve(moduleRoot, "../../dist/src/cli.js"), "doctor", "--repo", repository, "--engine", "codex", "--json"]
    : compileOnly
      ? [process.execPath, join(workerRoot, "dist", "src", "cli.js"), "compile", "--repo", repository, "--plan", join(repository, "Plan/api-contract.md"), "--json"]
      : [process.execPath, resolve(moduleRoot, "../../dist/src/cli.js"), "run", "--repo", repository, "--plan", join(repository, "Plan/api-contract.md"), "--engine", "codex"];
  stdin = undefined;
} else {
  writeFileSync(join(repository, "README.md"), "BENCH-09 isolated provider-entry diagnostic.\n", "utf8");
}
if (process.argv.includes("--git") || process.argv.includes("--worker-write") || infoapex) {
  execFileSync("git", ["init", "--quiet"], { cwd: repository, stdio: "ignore" });
  execFileSync("git", ["-c", "user.name=benchmark", "-c", "user.email=benchmark@localhost", "add", "."], { cwd: repository, stdio: "ignore" });
  execFileSync("git", ["-c", "user.name=benchmark", "-c", "user.email=benchmark@localhost", "commit", "--quiet", "-m", "diagnostic fixture"], { cwd: repository, stdio: "ignore" });
}
const result = await runBoundedProcess({
  command,
  cwd: repository,
  ...(stdin === undefined ? {} : { stdin }),
  timeoutMs: infoapex ? 135_000 : process.argv.includes("--worker-write") ? 20_000 : 30_000,
  maximumOutputBytes: infoapex ? 1_000_000 : 65_536,
  environmentNames: []
});
const redact = (value) => value
  .replace(/\b(sk-[A-Za-z0-9_-]{8,}|Bearer\s+\S+)/giu, "[REDACTED]")
  .replace(/((?:api[_-]?key|token|secret|password|authorization)\s*[=:]\s*)\S+/giu, "$1[REDACTED]");
console.log(JSON.stringify({
  mode: doctorOnly ? "infoapex-doctor" : compileOnly ? "infoapex-compile" : infoapex ? "infoapex-orchestrated-no-icm" : process.argv.includes("--worker-write") ? "worker-codex-write" : "direct-codex",
  repositoryInitialized: process.argv.includes("--git") || process.argv.includes("--worker-write") || infoapex,
  smokeFileWritten: process.argv.includes("--worker-write") ? (await import("node:fs")).existsSync(join(repository, "smoke.txt")) : null,
  exitCode: result.exitCode,
  signal: result.signal,
  timedOut: result.timedOut,
  outputTruncated: result.outputTruncated,
  processError: result.processError,
  capturedBytes: result.capturedBytes,
  stdout: redact(result.stdout),
  stderr: redact(result.stderr)
}, null, 2));

function option(name) { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] ?? null : null; }
