#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// This is a release gate, not a capability declaration.  The worker's doctor
// report must contain a concrete OS-isolated boundary and no unverifiable
// warnings before a stable release can be published.
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const workerCli = resolve(root, "modules/ai-code-worker/dist/src/cli.js");
const requiredCapabilities = [
  "filesystem-restricted",
  "worktree-write-mount",
  "network-deny-repository-processes",
  "environment-scrubbed",
  "process-limits",
  "output-limits",
  "process-tree-cancellation"
];

const checks = [];
let report = null;

if (!existsSync(workerCli)) {
  check("worker-doctor", false, "the built ai-code-worker doctor is missing");
} else {
  try {
    const output = execFileSync(process.execPath, [workerCli, "doctor", "--repo", root, "--engine", "fake", "--json"], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"]
    });
    report = JSON.parse(output);
    check("worker-doctor", report?.status === "PASS", "worker doctor must pass");
  } catch {
    check("worker-doctor", false, "worker doctor could not produce a valid report");
  }
}

const environment = report?.executionEnvironment ?? null;
check(
  "os-isolated-boundary",
  environment?.supported === true && environment?.securityBoundary === "os-isolated",
  "the selected backend must report an enforced OS-isolated security boundary"
);
check(
  "required-isolation-capabilities",
  requiredCapabilities.every((capability) => environment?.capabilities?.includes(capability)) &&
    (!environment?.missingCapabilities || environment.missingCapabilities.length === 0),
  "the selected backend must enforce every isolated profile capability"
);
check(
  "isolation-warnings",
  Array.isArray(environment?.warnings) && environment.warnings.length === 0,
  "an isolated release backend must not carry unverifiable isolation warnings"
);

const passed = checks.every((entry) => entry.status === "PASS");
const result = {
  schemaVersion: "1.0",
  status: passed ? "PASS" : "BLOCKED",
  code: passed ? "ISOLATION_BACKEND_PROVEN" : "ISOLATION_BACKEND_UNPROVEN",
  backend: environment?.backend ?? null,
  backendVersion: environment?.backendVersion ?? null,
  securityBoundary: environment?.securityBoundary ?? null,
  capabilities: environment?.capabilities ?? [],
  missingCapabilities: environment?.missingCapabilities ?? requiredCapabilities,
  warnings: environment?.warnings ?? [],
  checks
};
console.log(JSON.stringify(result, null, 2));
process.exitCode = passed ? 0 : 2;

function check(id, pass, detail) {
  checks.push({ id, status: pass ? "PASS" : "BLOCKED", detail });
}
