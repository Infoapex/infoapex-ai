import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const root = process.cwd();
const ignoredDirectories = new Set([".git", "node_modules", "dist", "coverage", ".ai-code-control", ".ai-code-worker"]);
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
