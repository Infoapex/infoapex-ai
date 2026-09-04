#!/usr/bin/env node
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = resolve(fileURLToPath(new URL(".", import.meta.url)));
const moduleRoot = resolve(here, "../../../modules/ai-code-benchmark");
const pilot = await import(pathToFileURL(join(moduleRoot, "dist/src/pilot/driver.js")).href);
const fake = process.argv.includes("--fake");
const stateRoot = resolve(option("--state-root") ?? mkdtempSync(join(tmpdir(), "bench-09-state-")));
mkdirSync(stateRoot, { recursive: true });
const repositoryPath = resolve(option("--repo") ?? mkdtempSync(join(tmpdir(), "bench-09-repository-")));
const result = await pilot.pilotPreflight({ suiteRoot: here, repositoryPath, stateRoot, configPath: option("--config") ?? undefined, fake });
if (result.ok && option("--out")) { writeFileSync(resolve(option("--out")), JSON.stringify(result.experiment, null, 2) + "\n", "utf8"); }
console.log(JSON.stringify({ status: result.ok ? "PASS" : "BLOCKED", ...result }, null, 2));
if (!result.ok) process.exitCode = 3;

function option(name) { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] ?? null : null; }
