import AdmZip from "adm-zip";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, existsSync, writeFileSync, mkdirSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// P3, steps 2-6 (docs/plans/INFOAPEX-AI-ROADMAP-P0-P5.md section 7): extract a release ZIP
// into a directory with none of this checkout's dist/, node_modules/, or git history: git
// archive (build-release-zip.mjs) already guarantees the ZIP itself has no such files, and
// this script extracts into a fresh mkdtemp directory, so nothing from the developer machine
// (PATH entries aside) can leak into the "clean install" being verified. Then setup/build/test
// from scratch, and a smoke chain covering all six modules: BENCH-D plus
// value-gate (planner+worker),
// pilot:icm-graph (planner+worker+control), review-gate (planner+worker+review), docs-gate
// (planner+worker+review+docs), plus the root installer's own init/status/handoff in both
// independent and integrated mode against a disposable target directory.

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const keep = process.argv.includes("--keep");
const explicitZip = option("--zip");
const timeoutMs = Number(process.env.APEX_RELEASE_SMOKE_TIMEOUT_MS ?? 20 * 60_000);

// realpathSync.native: see the identical, fuller comment in docs-gate.mjs.
const workspace = realpathSync.native(mkdtempSync(join(tmpdir(), "infoapex-release-smoke-")));
const extractedRoot = join(workspace, "extracted");
const steps = [];

try {
  const zipPath = explicitZip
    ? resolve(root, explicitZip)
    : buildZip();

  step("extract ZIP into a clean directory", () => {
    const zip = new AdmZip(zipPath);
    zip.extractAllTo(extractedRoot, true);
    for (const forbidden of ["node_modules", "dist", ".git"]) {
      if (existsSync(join(extractedRoot, forbidden))) {
        throw new Error(`Extracted release ZIP unexpectedly contains ${forbidden} - the ZIP is not clean.`);
      }
    }
  });

  step("npm run setup (npm ci across root + all 6 modules, no dev cache)", () => {
    run(npm, ["run", "setup"], extractedRoot);
  });

  step("npm run build (root + all 6 modules)", () => {
    run(npm, ["run", "build"], extractedRoot);
  });

  step("npm test (root installer's own tests, from the clean build)", () => {
    run(npm, ["test"], extractedRoot);
  });

  step("ai-code-benchmark deterministic suite, contracts, recovery, and security", () => {
    run(npm, ["test", "--prefix", "modules/ai-code-benchmark"], extractedRoot);
  });

  step("BENCH-D hermetic deterministic harness", () => {
    run(npm, ["run", "benchmark:deterministic", "--prefix", "modules/ai-code-benchmark"], extractedRoot);
  });

  step("value-gate:internal (planner + worker, 20 generic tasks, engine fake)", () => {
    run(npm, ["run", "value-gate:internal"], extractedRoot);
  });

  step("pilot:icm-graph:internal (planner + worker + control, 25 hybrid queries)", () => {
    run(npm, ["run", "pilot:icm-graph:internal"], extractedRoot);
  });

  step("review-gate:internal (planner + worker + review, read-only)", () => {
    run(npm, ["run", "review-gate:internal"], extractedRoot);
  });

  step("docs-gate:internal (planner + worker + review + docs)", () => {
    run(npm, ["run", "docs-gate:internal"], extractedRoot);
  });

  const targetIndependent = mkdtempSync(join(workspace, "target-independent-"));
  const targetIntegrated = mkdtempSync(join(workspace, "target-integrated-"));
  const rootCli = join(extractedRoot, "dist", "src", "cli.js");

  step("root installer: init + status in independent mode", () => {
    const init = runJson(process.execPath, [rootCli, "init", "--repo", targetIndependent, "--mode", "independent"], extractedRoot);
    if (init.mode !== "independent") throw new Error(`Expected independent mode, got ${JSON.stringify(init)}`);
    const status = runJson(process.execPath, [rootCli, "status", "--repo", targetIndependent], extractedRoot);
    if (status.config?.mode !== "independent") throw new Error(`status did not report independent mode: ${JSON.stringify(status)}`);
  });

  step("root installer: init + handoff (both directions) + status in integrated mode", () => {
    runJson(process.execPath, [rootCli, "init", "--repo", targetIntegrated, "--mode", "integrated"], extractedRoot);
    const payloadPath = join(targetIntegrated, "payload.json");
    writeFileSync(payloadPath, JSON.stringify({ plan: "smoke-test-plan" }), "utf8");
    runJson(process.execPath, [rootCli, "handoff", "--repo", targetIntegrated, "--direction", "planner-to-worker", "--run-id", "smoke-run", "--payload", "payload.json"], extractedRoot);
    runJson(process.execPath, [rootCli, "handoff", "--repo", targetIntegrated, "--direction", "worker-to-planner", "--run-id", "smoke-run", "--payload", "payload.json"], extractedRoot);
    const status = runJson(process.execPath, [rootCli, "status", "--repo", targetIntegrated], extractedRoot);
    if (status.config?.mode !== "integrated") throw new Error(`status did not report integrated mode: ${JSON.stringify(status)}`);
  });

  const failed = steps.filter((entry) => entry.status !== "PASS");
  const report = {
    schemaVersion: "1.0",
    status: failed.length === 0 ? "PASS" : "BLOCKED",
    zipPath,
    extractedRoot: keep ? extractedRoot : null,
    steps
  };
  console.log(JSON.stringify(report, null, 2));
  process.exitCode = failed.length === 0 ? 0 : 2;
} finally {
  if (!keep) {
    rmSync(workspace, { recursive: true, force: true });
  } else {
    console.error(`--keep: workspace left at ${workspace}`);
  }
}

function buildZip() {
  const outPath = join(workspace, "release.zip");
  const result = spawnSync(process.execPath, [join(root, "scripts", "build-release-zip.mjs"), "--out", outPath, ...process.argv.slice(2).filter((arg) => arg !== "--keep")], {
    cwd: root,
    encoding: "utf8",
    windowsHide: true
  });
  if (result.status !== 0) {
    console.error(result.stdout);
    console.error(result.stderr);
    throw new Error("build-release-zip.mjs failed - see output above.");
  }
  const built = JSON.parse(result.stdout);
  return built.zipPath;
}

function step(name, fn) {
  const startedAt = Date.now();
  process.stderr.write(`\n=== ${name} ===\n`);
  try {
    fn();
    steps.push({ name, status: "PASS", durationMs: Date.now() - startedAt });
  } catch (error) {
    steps.push({ name, status: "BLOCKED", durationMs: Date.now() - startedAt, error: error instanceof Error ? error.message : String(error) });
    throw error;
  }
}

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, stdio: "inherit", windowsHide: true, shell: process.platform === "win32", timeout: timeoutMs });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} exited with status ${result.status}`);
  }
}

function runJson(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, encoding: "utf8", windowsHide: true, timeout: timeoutMs });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} exited with status ${result.status}: ${result.stderr}`);
  }
  return JSON.parse(result.stdout);
}

function option(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] ?? null : null;
}
