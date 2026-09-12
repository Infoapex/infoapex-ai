import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// P6.2: validate the npm artefact itself, not the source checkout. The package
// is installed with a fresh dependency tree and its installed entry points are
// exercised from a disposable target repository.
const root = resolve(import.meta.dirname, "..");
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const workspace = mkdtempSync(join(tmpdir(), "infoapex-package-smoke-"));
const packRoot = join(workspace, "pack");
const installRoot = join(workspace, "install");
const targetRoot = join(workspace, "target");
mkdirSync(packRoot, { recursive: true });
mkdirSync(targetRoot, { recursive: true });
const npmOptions = { cwd: root, encoding: "utf8", windowsHide: true, shell: process.platform === "win32", stdio: "pipe" };

try {
  const packed = JSON.parse(execFileSync(npm, ["pack", "--json", "--ignore-scripts", "--pack-destination", packRoot], npmOptions))[0];
  const tarball = resolve(packRoot, packed.filename);
  if (!existsSync(tarball)) throw new Error(`npm pack reported a missing artefact: ${tarball}`);

  execFileSync(npm, ["install", tarball, "--ignore-scripts", "--no-save", "--package-lock=false", "--prefix", installRoot], npmOptions);
  const packageRoot = join(installRoot, "node_modules", "@infoapex", "infoapex-ai");
  const cli = join(packageRoot, "dist", "src", "cli.js");
  if (!existsSync(cli)) throw new Error("Installed package is missing dist/src/cli.js.");

  const help = runNode(cli, ["help"]);
  if (!help.includes("infoapex-ai - local governance layer")) throw new Error("Installed root CLI did not return its help contract.");

  const status = JSON.parse(runNode(cli, ["status", "--repo", targetRoot]));
  if (status.status !== "INDEPENDENT" || status.configured !== false) throw new Error(`Unexpected clean-target status: ${JSON.stringify(status)}`);

  const init = JSON.parse(runNode(cli, ["init", "--repo", targetRoot, "--mode", "independent"]));
  if (init.status !== "DONE") throw new Error(`Installed root CLI could not initialize a target: ${JSON.stringify(init)}`);

  const delegatedHelp = JSON.parse(runNode(cli, ["benchmark", "help"]));
  if (delegatedHelp.status !== "PASS" || delegatedHelp.module !== "ai-code-benchmark") {
    throw new Error(`Installed delegated CLI failed: ${JSON.stringify(delegatedHelp)}`);
  }

  console.log(JSON.stringify({
    status: "PASS",
    package: packed.name,
    version: packed.version,
    tarballBytes: packed.size,
    target: targetRoot,
    exercised: ["root help", "root status", "root init", "benchmark help"]
  }, null, 2));
} finally {
  rmSync(workspace, { recursive: true, force: true });
}

function runNode(entry, args) {
  // The installed artefact owns both the executable and module resolution.
  // Running from the disposable target makes an accidental source-checkout
  // import fail rather than being masked by this repository's dependencies.
  return execFileSync(process.execPath, [entry, ...args], {
    cwd: targetRoot,
    encoding: "utf8",
    windowsHide: true,
    env: { ...process.env, npm_config_offline: "true" }
  }).trim();
}
