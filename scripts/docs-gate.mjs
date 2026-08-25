import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const apexRoot = fileURLToPath(new URL("..", import.meta.url));
const docsRoot = join(apexRoot, "modules", "ai-code-docs");
const plannerCli = join(apexRoot, "modules", "ai-code-planner", "dist", "src", "cli.js");
const workerCli = join(apexRoot, "modules", "ai-code-worker", "dist", "src", "cli.js");
const reviewCli = join(apexRoot, "modules", "ai-code-review", "dist", "src", "cli.js");
const fixture = join(apexRoot, "modules", "ai-code-worker", "tests", "fixtures", "review", "pass-no-findings.json");

const root = mkdtempSync(join(tmpdir(), "apex-docs-gate-"));
try {
  mkdirSync(join(root, "Plan"), { recursive: true });
  mkdirSync(join(root, "scripts"), { recursive: true });
  mkdirSync(join(root, ".ai-code-docs"), { recursive: true });
  mkdirSync(join(root, ".ai-code-review"), { recursive: true });
  writeFileSync(join(root, "README.md"), "# Documentation fixture\n", "utf8");
  writeFileSync(join(root, "scripts", "pass-gate.mjs"), "process.exit(0);\n", "utf8");
  writeFileSync(join(root, "scripts", "control.mjs"), "const command=process.argv.at(-1); console.log(command==='health-check' ? '{\"status\":\"PASS\"}' : 'docs context');\n", "utf8");
  writeFileSync(join(root, ".ai-code-review", "config.json"), `${JSON.stringify({ schemaVersion: "1.0", planner: [process.execPath, plannerCli], worker: [process.execPath, workerCli], control: [process.execPath, join(root, "scripts", "control.mjs")], defaultEngine: "fake" }, null, 2)}\n`, "utf8");

  const draft = {
    goal: "Generate verified documentation",
    tasks: [{
      id: "DOCS-001",
      goal: "Generate the requested documentation from repository evidence.",
      acceptanceCriteria: [{ criterionId: "AC-01", text: "Documentation is generated from verified repository evidence." }],
      gates: [{ gateId: "docs-gate", command: "node scripts/pass-gate.mjs", evidenceContract: "The documentation gate exits successfully." }],
      dependsOn: [],
      scope: { allowedPaths: ["docs/generated/**"], forbiddenPaths: ["src/**"] },
      requiredInputs: [{ kind: "file", ref: "README.md" }],
      risk: "low"
    }]
  };
  writeFileSync(join(root, "draft.json"), `${JSON.stringify(draft, null, 2)}\n`, "utf8");
  const workerPlan = {
    goal: "Generate verified documentation",
    tasks: [{ id: "DOCS-001", kind: "docs", role: "writer", dependsOn: [], requiredInputs: ["README.md"], allowedPaths: ["docs/generated/**"], forbiddenPaths: ["src/**"], expectedArtifacts: ["docs/generated/"], acceptanceCriteria: ["Documentation is generated from verified repository evidence."], verify: ["node scripts/pass-gate.mjs"], concurrencyKeys: ["docs/generated"], risk: "low" }],
    globalGates: [],
    budgets: { maximumParallelWriters: 1, maximumRepairCycles: 0, maximumTaskMinutes: 5, maximumRunMinutes: 10, maximumAgentInvocations: 2, maximumRunInputUncachedTokens: 200000, maximumRunCacheReadTokens: 200000, maximumRunCacheWriteTokens: 200000, maximumRunOutputTokens: 50000, maximumRunCostUsd: 1, onUnknownUsage: "warn" }
  };
  writeFileSync(join(root, "Plan", "DOCS-001.md"), ["---", "status: accepted", "---", "", "# Generate verified documentation", "", "```ai-code-worker-plan", JSON.stringify(workerPlan, null, 2), "```", ""].join("\n"), "utf8");
  git("init", "-b", "main");
  git("config", "user.email", "ci@example.invalid");
  git("config", "user.name", "Infoapex AI CI");
  git("add", ".");
  git("commit", "-m", "docs fixture");
  writeFileSync(join(root, "request.json"), `${JSON.stringify({ schemaVersion: "1.0", runId: "apex-docs-gate", docsId: "DOCS-001", baseCommit: "BASE", headCommit: "HEAD", prompt: "Generate verified documentation.", criteria: [{ id: "AC-01", description: "Documentation is generated from verified repository evidence." }], outputPaths: ["docs/generated/"], plannerDraftPath: "draft.json", workerPlanPath: "Plan/DOCS-001.md", reviewFixturePath: fixture }, null, 2)}\n`, "utf8");
  writeFileSync(join(root, ".ai-code-docs", "config.json"), `${JSON.stringify({ schemaVersion: "1.0", planner: [process.execPath, plannerCli], worker: [process.execPath, workerCli], control: [process.execPath, join(root, "scripts", "control.mjs")], review: [process.execPath, reviewCli], defaultEngine: "fake", defaultReviewEngine: "fake" }, null, 2)}\n`, "utf8");

  const result = run(process.execPath, [join(docsRoot, "dist", "src", "cli.js"), "generate", "--repo", root, "--request", "request.json", "--planner-draft", "draft.json", "--worker-plan", "Plan/DOCS-001.md", "--engine", "fake", "--review-engine", "fake", "--out", "report.json"], root);
  const report = JSON.parse(result.stdout);
  console.log(JSON.stringify({ status: result.status === 0 && report.status === "DONE" ? "PASS" : "BLOCKED", report }, null, 2));
  process.exitCode = result.status === 0 && report.status === "DONE" ? 0 : 2;
} finally {
  rmSync(root, { recursive: true, force: true });
}

function git(...args) {
  execFileSync("git", args, { cwd: root, stdio: "ignore", windowsHide: true });
}

function run(command, args, cwd) {
  return spawnSync(command, args, { cwd, encoding: "utf8", windowsHide: true, maxBuffer: 8 * 1024 * 1024 });
}
