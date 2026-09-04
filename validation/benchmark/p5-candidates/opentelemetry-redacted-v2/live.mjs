#!/usr/bin/env node
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = resolve(fileURLToPath(new URL(".", import.meta.url)));
const bundleRoot = resolve(here, "../../../..");
const moduleRoot = join(bundleRoot, "modules", "ai-code-benchmark");
const candidate = await import(pathToFileURL(join(moduleRoot, "dist", "src", "p5", "otel-candidate.js")).href);
for (const name of ["--repo", "--state-root", "--experiment", "--config", "--authorization"]) if (!option(name)) throw new Error(`${name} is required.`);
const result = await candidate.runOtelCandidate({
  suiteRoot: join(bundleRoot, "validation", "benchmark", "pilot"),
  repositoryPath: resolve(option("--repo")), stateRoot: resolve(option("--state-root")), experimentPath: resolve(option("--experiment")),
  configPath: resolve(option("--config")), authorizationPath: resolve(option("--authorization")), hypothesisPath: join(here, "candidate-hypothesis.json"),
  maximumNewObservations: positiveIntegerOption("--maximum-new-observations"), resume: process.argv.includes("--resume")
});
console.log(JSON.stringify({ status: result.report?.verdict ?? "DONE", ...result }, null, 2));
function option(name) { const index = process.argv.indexOf(name); return index >= 0 ? process.argv[index + 1] ?? null : null; }
function positiveIntegerOption(name) { const raw = option(name); if (raw === null) return undefined; const value = Number(raw); if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be a positive integer.`); return value; }
