import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const root = process.cwd();
const requiredFiles = [
  "README.md",
  "docs/IMPLEMENTATION-PLAN.md",
  "docs/amendments/v1.2-safety-execution-and-recovery.md",
  "docs/adr/0001-scope-hook-interoperability.md",
  "docs/adr/0002-execution-environments.md",
  "docs/adr/0003-instruction-trust-and-run-authorization.md",
  "docs/adr/0004-dependency-snapshots-and-graph-revisions.md",
  "docs/adr/0005-streaming-engine-adapter.md",
  "docs/adr/0006-minimum-recovery-before-pilot.md",
  "schemas/project-config.schema.json",
  "schemas/manifest.schema.json",
  "schemas/quality-gates.schema.json",
  "schemas/execution-environment.schema.json",
  "schemas/run-intent.schema.json",
  "schemas/run-authorization.schema.json",
  "schemas/task-input-snapshot.schema.json",
  "schemas/engine-event.schema.json",
  "schemas/evidence.schema.json",
  "schemas/pilot-baseline.schema.json",
  "schemas/review-finding.schema.json",
  "schemas/independent-review.schema.json",
  "schemas/repair-task.schema.json",
  "schemas/repair-attempt.schema.json",
  "schemas/repair-budget.schema.json",
  "schemas/repeated-failure-signature.schema.json",
  "schemas/graph-revision.schema.json",
  "schemas/superseded-run.schema.json",
  "templates/project/.ai-code-worker/config.json",
  "templates/project/.ai-code-worker/execution-environment.example.json",
  "templates/project/.ai-code-worker/pilot-baseline.example.json",
  "templates/reports/event.example.json",
  "templates/reports/evidence.example.json",
  "templates/reports/review.example.json",
  "templates/reports/run-intent.example.json",
  "templates/reports/run-authorization.example.json",
  "templates/reports/task-input.example.json",
  "templates/reports/engine-event.example.json",
  "templates/reports/review-finding.example.json",
  "templates/reports/independent-review.example.json",
  "templates/reports/repair-task.example.json",
  "templates/reports/repair-attempt.example.json",
  "templates/reports/repair-budget.example.json",
  "templates/reports/repeated-failure-signature.example.json",
  "templates/reports/graph-revision.example.json",
  "templates/reports/superseded-run.example.json"
];

const ignoredDirectories = new Set([".git", "node_modules", "dist", "coverage"]);
const jsonFiles = [];

function walk(directory) {
  for (const entry of readdirSync(directory)) {
    if (ignoredDirectories.has(entry)) {
      continue;
    }

    const fullPath = join(directory, entry);
    const stats = statSync(fullPath);

    if (stats.isDirectory()) {
      walk(fullPath);
      continue;
    }

    if (entry.endsWith(".json")) {
      jsonFiles.push(fullPath);
    }
  }
}

function fail(message) {
  console.error(message);
  process.exitCode = 1;
}

for (const file of requiredFiles) {
  try {
    statSync(join(root, file));
  } catch {
    fail(`missing required file: ${file}`);
  }
}

walk(root);

for (const file of jsonFiles) {
  const relativePath = relative(root, file).replaceAll("\\", "/");
  try {
    JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    fail(`invalid JSON in ${relativePath}: ${error.message}`);
  }
}

if (process.exitCode) {
  process.exit();
}

console.log(`validated ${jsonFiles.length} JSON files`);
