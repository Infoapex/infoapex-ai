import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// P6.2: validate the npm artefact itself, not the source checkout. The package
// is installed with a fresh dependency tree and its installed entry points are
// exercised from a disposable target repository.
const root = resolve(import.meta.dirname, "..");
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
// Keep npm's prefix and local tarball URL on the same canonical path on macOS
// (/var is an alias of /private/var), as in the release ZIP smoke test.
const workspace = realpathSync.native(mkdtempSync(join(tmpdir(), "infoapex-package-smoke-")));
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

  // npm ci caches locked tarballs, not necessarily registry metadata. Reuse the
  // reviewed resolutions so a clean runner needs no cached version-range lookup.
  const sourceLock = JSON.parse(readFileSync(join(root, "package-lock.json"), "utf8"));
  const sourcePackage = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const dependency = pathToFileURL(tarball).href;
  const fixture = { name: "infoapex-package-smoke", version: "1.0.0", private: true, dependencies: { [packed.name]: dependency } };
  const { [""]: _rootPackage, ...dependencies } = sourceLock.packages;
  const lock = { name: fixture.name, version: fixture.version, lockfileVersion: 3, requires: true, packages: {
    "": fixture,
    ...dependencies,
    [`node_modules/${packed.name}`]: { version: packed.version, resolved: dependency, integrity: packed.integrity, dependencies: sourcePackage.dependencies, bin: sourcePackage.bin }
  } };
  mkdirSync(installRoot, { recursive: true });
  writeFileSync(join(installRoot, "package.json"), JSON.stringify(fixture));
  writeFileSync(join(installRoot, "package-lock.json"), JSON.stringify(lock));
  execFileSync(npm, ["ci", "--ignore-scripts", "--omit=dev", "--offline", "--prefix", installRoot], npmOptions);
  const packageRoot = join(installRoot, "node_modules", "@infoapex", "infoapex-ai");
  const cli = join(packageRoot, "dist", "src", "cli.js");
  if (!existsSync(cli)) throw new Error("Installed package is missing dist/src/cli.js.");
  const installedPackage = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"));
  if (installedPackage.name !== "@infoapex/infoapex-ai" || installedPackage.version !== packed.version) {
    throw new Error("Installed package identity does not match the packed artifact.");
  }
  const provenance = JSON.parse(readFileSync(join(packageRoot, "modules", "provenance.json"), "utf8"));
  if (typeof provenance.schemaVersion !== "string" || !Array.isArray(provenance.modules) || provenance.modules.length === 0 ||
    !provenance.modules.every((module) => typeof module.name === "string" && /^[0-9a-f]{40}$/i.test(module.sourceCommit))) {
    throw new Error("Installed package has invalid module provenance.");
  }

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
    exercised: ["package identity", "module provenance", "root help (offline)", "root status (offline)", "root init (offline)", "benchmark help (offline)"]
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
