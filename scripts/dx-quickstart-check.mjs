#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(process.cwd());
const rootCli = join(root, "dist", "src", "cli.js");
const workerCli = join(root, "modules", "ai-code-worker", "dist", "src", "cli.js");
const repo = mkdtempSync(join(tmpdir(), "infoapex-p6-dx-"));
function run(args, cwd = repo) { return execFileSync(process.execPath, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }); }
function git(args) { execFileSync("git", args, { cwd: repo, stdio: "ignore" }); }
try {
  mkdirSync(join(repo, "Plan"), { recursive: true });
  mkdirSync(join(repo, "scripts"), { recursive: true });
  writeFileSync(join(repo, "README.md"), "# disposable consumer\n", "utf8");
  writeFileSync(join(repo, "scripts", "pass.mjs"), "process.exit(0);\n", "utf8");
  const plan = { goal: "DX fake first run", tasks: [{ id: "DX-01", kind: "test", role: "consumer", dependsOn: [], requiredInputs: ["README.md"], allowedPaths: ["first-run.txt"], forbiddenPaths: [".git/**"], expectedArtifacts: ["first-run.txt"], acceptanceCriteria: ["complete a bounded fake run"], verify: ["node scripts/pass.mjs"], concurrencyKeys: ["dx"], risk: "low" }], globalGates: [], budgets: { maximumParallelWriters: 1, maximumRepairCycles: 0, maximumTaskMinutes: 5, maximumRunMinutes: 10, maximumAgentInvocations: 1, maximumRunInputUncachedTokens: 100000, maximumRunCacheReadTokens: 100000, maximumRunCacheWriteTokens: 100000, maximumRunOutputTokens: 20000, maximumRunCostUsd: null, onUnknownUsage: "allow" } };
  const planMarkdown = ["---", "status: accepted", "---", "", "# First fake run", "", "```json ai-code-worker-plan", JSON.stringify(plan, null, 2), "```", ""].join("\n");
  writeFileSync(join(repo, "Plan", "FIRST-RUN.md"), planMarkdown, "utf8");
  git(["init", "--initial-branch", "main"]); git(["config", "user.name", "Infoapex DX"]); git(["config", "user.email", "dx@example.invalid"]); git(["add", "."]); git(["commit", "-m", "disposable consumer"]);
  const init = JSON.parse(run([rootCli, "init", "--repo", repo, "--mode", "integrated"]));
  if (init.status !== "DONE") throw new Error("INIT_NOT_DONE");
  const workerInit = JSON.parse(run([workerCli, "init", "--repo", repo, "--json"]));
  if (workerInit.status !== "CREATED") throw new Error("WORKER_INIT_NOT_CREATED");
  git(["add", ".infoapex-ai", ".ai-code-worker"]); git(["commit", "-m", "consumer worker config"]);
  const report = JSON.parse(run([workerCli, "run", "--repo", repo, "--plan", "Plan/FIRST-RUN.md", "--run-id", "dx-first-run", "--engine", "fake", "--json"]));
  if (report.status !== "DONE") throw new Error(`FAKE_RUN_${report.status}`);
  console.log(JSON.stringify({ schemaVersion: "1.0", status: "PASS", code: "DX_QUICKSTART_PASS", firstRun: report.runId, repository: "isolated-temporary-consumer", provider: "fake", targetMinutes: 15 }, null, 2));
} finally { rmSync(repo, { recursive: true, force: true }); }
