#!/usr/bin/env node
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Hash committed Git blobs, never the working tree, so a release workflow can
// attest exactly which security and release policy it built.
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const output = resolve(root, option("--out") ?? positional() ?? "dist-release/policy-manifest.json");
const commit = git(["rev-parse", "HEAD^{commit}"]).trim();
const policyFiles = [
  ".github/workflows/release.yml",
  "docs/P6-THREAT-MODEL.md",
  "scripts/isolation-preflight.mjs",
  "modules/ai-code-worker/schemas/execution-environment.schema.json",
  "modules/ai-code-worker/templates/project/.ai-code-worker/execution-environment.example.json",
  "src/production.ts",
  "validation/p6/evidence-index.json",
  "validation/p6/release-gates.json",
  "validation/p6/solo-release-policy.json",
  "validation/p6/solo-go-no-go.schema.json"
];
const files = policyFiles.map((path) => ({ path, sha256: createHash("sha256").update(git(["show", `${commit}:${path}`], true)).digest("hex") }));
const manifest = { schemaVersion: "1.0", kind: "infoapex-ai-policy-manifest", commit, files };
mkdirSync(dirname(output), { recursive: true });
writeFileSync(output, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
console.log(JSON.stringify({ status: "PASS", output, commit, files: files.length }, null, 2));

function option(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] ?? null : null;
}
function positional() {
  return process.argv.slice(2).find((value) => !value.startsWith("--")) ?? null;
}
function git(args, binary = false) {
  return execFileSync("git", args, { cwd: root, encoding: binary ? undefined : "utf8", stdio: ["ignore", "pipe", "pipe"] });
}
