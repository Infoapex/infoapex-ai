#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const root = resolve(process.cwd());
const required = [
  "README.md", "CHANGELOG.md", "RELEASE-NOTES.md", "docs/P6-DX.md", "docs/P6-PILOT.md",
  "docs/P6-TROUBLESHOOTING.md", "docs/P6-SLO.md", "docs/P6-SUPPORT-POLICY.md",
  "scripts/build-release-zip.mjs", "scripts/generate-sbom.mjs", "scripts/release-smoke-test.mjs",
  "validation/p6/release-gates.json", "validation/p6/pilot-preregistration.json"
];
const checks = [];
function check(id, pass, detail) { checks.push({ id, status: pass ? "PASS" : "BLOCKED", detail }); }
for (const path of required) check(`file:${path}`, existsSync(join(root, path)), existsSync(join(root, path)) ? "present" : "required artifact is missing");

let pkg = null;
try { pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")); check("package-json", true, `version ${pkg.version}`); }
catch { check("package-json", false, "package.json is invalid"); }
check("candidate-version", typeof pkg?.version === "string" && pkg.version !== "1.0.0", "GA version is not claimed by the local pre-release audit");

try {
  const gates = JSON.parse(readFileSync(join(root, "validation/p6/release-gates.json"), "utf8"));
  const valid = Array.isArray(gates.gates) && gates.gates.length >= 9 && gates.gates.every((gate) => gate.status === "PENDING" || gate.status === "PASS" || gate.status === "INCONCLUSIVE");
  check("release-gate-registry", valid, valid ? `${gates.gates.length} gates retain explicit evidence state` : "release-gate registry is malformed");
} catch { check("release-gate-registry", false, "release-gate registry is not readable"); }

try {
  const pilot = JSON.parse(readFileSync(join(root, "validation/p6/pilot-preregistration.json"), "utf8"));
  const honest = pilot.status === "NOT_STARTED" && pilot.verdict === null && Array.isArray(pilot.evidence) && pilot.evidence.length === 0;
  check("consumer-pilot-boundary", honest, honest ? "external pilot evidence is absent and not represented as PASS" : "pilot evidence boundary is invalid");
} catch { check("consumer-pilot-boundary", false, "pilot preregistration is not readable"); }

const npm = process.platform === "win32" ? "npm.cmd" : "npm";
try {
  const packed = JSON.parse(execFileSync(npm, ["pack", "--dry-run", "--json", "--ignore-scripts"], { cwd: root, encoding: "utf8", windowsHide: true, shell: process.platform === "win32" }))[0];
  const files = packed.files.map((entry) => entry.path.replaceAll("\\", "/"));
  const forbidden = files.filter((path) => path.startsWith("validation/") || path.startsWith(".ai-code-control/") || path.startsWith(".infoapex-ai/") || path.startsWith("node_modules/") || path.startsWith("dist/tests/"));
  check("package-artifact-isolation", forbidden.length === 0, forbidden.length === 0 ? `${files.length} package files exclude local state` : `forbidden files: ${forbidden.join(", ")}`);
} catch (error) { check("package-artifact-isolation", false, error instanceof Error ? error.message : String(error)); }

const localPass = checks.every((entry) => entry.status === "PASS");
const result = {
  schemaVersion: "1.0",
  status: localPass ? "INCONCLUSIVE" : "BLOCKED",
  code: localPass ? "RC_LOCAL_AUDIT_PASS_EXTERNAL_EVIDENCE_MISSING" : "RC_LOCAL_AUDIT_BLOCKED",
  releaseAction: "NO_PUBLICATION",
  commit: git(["rev-parse", "HEAD"]),
  commitSha256: commitDigest(),
  localChecks: checks,
  missingExternalEvidence: ["consumer-pilot", "independent-security-audit", "owner-go-no-go", "signed-tag-and-publication"]
};
console.log(JSON.stringify(result, null, 2));
process.exitCode = localPass ? 0 : 2;

function git(args) { try { return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim(); } catch { return null; } }
function commitDigest() { const commit = git(["rev-parse", "HEAD"]); return commit ? createHash("sha256").update(commit).digest("hex") : null; }
