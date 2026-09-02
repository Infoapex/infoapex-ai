import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const apexRoot = fileURLToPath(new URL("..", import.meta.url));
const reviewRoot = join(apexRoot, "modules", "ai-code-review");
const reviewCli = join(reviewRoot, "dist", "src", "cli.js");
const workerCli = join(apexRoot, "modules", "ai-code-worker", "dist", "src", "cli.js");
const fixture = join(apexRoot, "modules", "ai-code-worker", "tests", "fixtures", "review", "pass-no-findings.json");

function run(command, args, cwd) {
  return spawnSync(command, args, { cwd, encoding: "utf8", windowsHide: true, maxBuffer: 4 * 1024 * 1024 });
}

// realpathSync.native: see the identical, fuller comment in docs-gate.mjs - Windows
// 8.3 short-name aliases on GitHub Actions runners otherwise diverge from what
// modules' own git preflight resolves.
const root = realpathSync.native(mkdtempSync(join(tmpdir(), "apex-review-gate-")));
try {
  const planner = join(root, "planner.mjs");
  const control = join(root, "control.mjs");
  const request = join(root, "request.json");
  const draft = join(root, "draft.json");
  const configDir = join(root, ".ai-code-review");
  mkdirSync(configDir, { recursive: true });
  writeFileSync(planner, "console.log(JSON.stringify({schemaValid:true,lintOk:true}));\n");
  writeFileSync(control, "const value=process.argv.at(-1); if(value==='health-check') console.log('{\"status\":\"PASS\"}'); else console.log('review context');\n");
  writeFileSync(draft, "{}\n");
  writeFileSync(request, JSON.stringify({
    schemaVersion: "1.0",
    runId: "apex-review-gate",
    reviewId: "apex-review-gate-001",
    baseCommit: "BASE",
    headCommit: "HEAD",
    criteria: [{ id: "CRIT-001", description: "The fixture remains valid.", verify: ["node scripts/pass-gate.mjs"] }]
  }, null, 2));
  writeFileSync(join(configDir, "config.json"), JSON.stringify({
    schemaVersion: "1.0",
    planner: [process.execPath, planner],
    worker: [process.execPath, workerCli],
    control: [process.execPath, control],
    defaultEngine: "fake"
  }, null, 2));

  const result = run(process.execPath, [reviewCli, "run", "--repo", root, "--request", request, "--planner-draft", draft, "--engine", "fake", "--fixture", fixture, "--json"], root);
  const report = JSON.parse(result.stdout);
  console.log(JSON.stringify({ status: result.status === 0 && report.status === "PASS" ? "PASS" : "BLOCKED", report }, null, 2));
  process.exitCode = result.status === 0 && report.status === "PASS" ? 0 : 2;
} finally {
  rmSync(root, { recursive: true, force: true });
}
