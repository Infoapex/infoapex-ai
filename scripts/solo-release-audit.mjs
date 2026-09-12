#!/usr/bin/env node
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const candidate = option("--candidate") ?? "v1.0.0-rc.1-internal";
const zipRelative = `dist-release/infoapex-ai-${candidate}.zip`;
const sbomRelative = `dist-release/infoapex-ai-${candidate}.cdx.json`;
const zipPath = join(root, zipRelative);
const checks = [];
const policy = JSON.parse(readFileSync(join(root, "validation/p6/solo-release-policy.json"), "utf8"));

check("tracked-tree-clean", exec(["diff", "--quiet", "HEAD", "--"], root), "tracked files are committed; untracked local state is excluded by git archive");
step("npm-test", "npm", ["test"]);
step("p6-verify", "npm", ["run", "p6:verify"]);
step("upgrade-rollback-tests", process.execPath, ["--test", "dist/tests/release-lifecycle.test.js", "dist/tests/config-lifecycle.test.js"]);
step("reproducible-release-zip", "npm", ["run", "release:build-zip", "--", "--ref", "HEAD", "--allow-dirty", "--out", zipRelative]);
step("cyclonedx-sbom", "npm", ["run", "release:sbom", "--", "--out", sbomRelative]);
step("clean-install-smoke", process.execPath, ["scripts/release-smoke-test.mjs", "--zip", zipRelative]);
verifyArtifacts();

const blocked = checks.filter((entry) => entry.status !== "PASS");
const result = {
  schemaVersion: "1.0",
  profile: policy.profile,
  candidate,
  status: blocked.length === 0 ? "PASS" : "BLOCKED",
  code: blocked.length === 0 ? "SOLO_INTERNAL_RC_READY" : "SOLO_INTERNAL_RC_BLOCKED",
  releaseAction: "INTERNAL_RC_ONLY",
  publicationAllowed: false,
  externalPilot: "OPTIONAL_POST_RELEASE",
  checks,
  artifacts: blocked.length === 0 ? { zip: zipRelative, sbom: sbomRelative, checksum: `${zipRelative}.sha256`, provenance: `${zipRelative}.manifest.json` } : null,
  maintainerDecision: "REQUIRED_BEFORE_PUBLICATION",
  commit: git(["rev-parse", "HEAD"]),
  commitSha256: createHash("sha256").update(git(["rev-parse", "HEAD"]).trim()).digest("hex")
};
console.log(JSON.stringify(result, null, 2));
process.exitCode = blocked.length === 0 ? 0 : 2;

function step(id, command, args) {
  const startedAt = Date.now();
  const status = run(command, args);
  checks.push({ id, status, durationMs: Date.now() - startedAt });
}
function verifyArtifacts() {
  const files = [zipPath, `${zipPath}.sha256`, `${zipPath}.manifest.json`, join(root, sbomRelative)];
  const present = files.every(existsSync);
  if (!present) { checks.push({ id: "artifact-metadata", status: "BLOCKED", detail: "candidate artifact, checksum, provenance, and SBOM must all exist" }); return; }
  try {
    const actual = createHash("sha256").update(readFileSync(zipPath)).digest("hex");
    const declared = readFileSync(`${zipPath}.sha256`, "utf8").trim().split(/\s+/)[0];
    const manifest = JSON.parse(readFileSync(`${zipPath}.manifest.json`, "utf8"));
    const sbom = JSON.parse(readFileSync(join(root, sbomRelative), "utf8"));
    const pass = actual === declared && manifest.sha256 === actual && sbom.bomFormat === "CycloneDX" && Array.isArray(sbom.components) && sbom.components.length > 0;
    checks.push({ id: "artifact-metadata", status: pass ? "PASS" : "BLOCKED", detail: pass ? "checksum, provenance, and SBOM match the candidate" : "artifact metadata mismatch" });
  } catch (error) { checks.push({ id: "artifact-metadata", status: "BLOCKED", detail: String(error) }); }
}
function run(command, args) {
  const executable = process.platform === "win32" && command === "npm" ? "npm.cmd" : command;
  const result = spawnSync(executable, args, { cwd: root, stdio: "inherit", windowsHide: true, shell: process.platform === "win32" && executable.endsWith(".cmd") });
  return result.status === 0 ? "PASS" : "BLOCKED";
}
function exec(args, cwd) { try { execFileSync("git", args, { cwd, stdio: "ignore" }); return true; } catch { return false; } }
function git(args) { return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim(); }
function option(name) { const index = process.argv.indexOf(name); return index >= 0 ? process.argv[index + 1] ?? null : null; }
