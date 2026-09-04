#!/usr/bin/env node
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = resolve(fileURLToPath(new URL(".", import.meta.url)));
const moduleRoot = resolve(here, "../../../modules/ai-code-benchmark");
const pilot = await import(pathToFileURL(join(moduleRoot, "dist/src/pilot/driver.js")).href);
const fake = process.argv.includes("--fake");
if (!fake && !option("--authorization")) throw new Error("Live BENCH-09 requires --authorization and never falls back.");
const stateRoot = resolve(option("--state-root") ?? mkdtempSync(join(tmpdir(), "bench-09-state-"))); mkdirSync(stateRoot, { recursive: true });
const repo = resolve(option("--repo") ?? process.cwd());
const experimentPath = resolve(option("--experiment") ?? join(here, "experiment.json"));
const maximumNewObservations = positiveIntegerOption("--maximum-new-observations");
if (!fake) {
  if (!readFileSync(experimentPath, "utf8")) throw new Error("Frozen experiment is required before live execution.");
}
const result = await pilot.runPilot({ suiteRoot: here, repositoryPath: repo, stateRoot, experimentPath, configPath: resolve(option("--config") ?? join(repo, ".ai-code-benchmark", "config.json")), authorizationPath: option("--authorization") ?? undefined, maximumNewObservations, fake, resume: process.argv.includes("--resume") });
console.log(JSON.stringify({ status: result.report?.verdict ?? "DONE", ...result }, null, 2));
function option(name) { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] ?? null : null; }
function positiveIntegerOption(name) {
  const raw = option(name); if (raw === null) return undefined;
  const value = Number(raw); if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be a positive integer.`);
  return value;
}
