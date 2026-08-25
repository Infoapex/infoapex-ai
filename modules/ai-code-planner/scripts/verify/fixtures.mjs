import { existsSync, readFileSync, readdirSync } from "node:fs";

let ok = true;

function check(condition, label) {
  if (!condition) {
    console.error(`failed: ${label}`);
    ok = false;
  }
}

const validManifestRaw = readFileSync("fixtures/valid/worker-v1.manifest.json", "utf8");
const validManifest = JSON.parse(validManifestRaw);
check(Array.isArray(validManifest.tasks) && validManifest.tasks.length >= 2, "valid manifest has at least 2 tasks");

const allowedKinds = new Set(["contract", "backend", "frontend", "database", "docs", "test", "review", "repair", "other"]);
const allowedRisks = new Set(["low", "medium", "high"]);

for (const task of validManifest.tasks ?? []) {
  check(allowedKinds.has(task.kind), `task ${task.id} kind is a known enum value`);
  check(allowedRisks.has(task.risk), `task ${task.id} risk is a known enum value`);
}

check(existsSync("fixtures/invalid"), "fixtures/invalid directory exists");

const invalidFiles = readdirSync("fixtures/invalid").filter((name) => name.endsWith(".json"));
check(invalidFiles.length >= 5, "at least 5 invalid fixture JSON files exist");

for (const file of invalidFiles) {
  JSON.parse(readFileSync(`fixtures/invalid/${file}`, "utf8"));
}

check(existsSync("fixtures/invalid/README.md"), "fixtures/invalid/README.md exists");

process.exit(ok ? 0 : 1);
