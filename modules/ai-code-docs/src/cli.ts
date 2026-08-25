#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { initConfig, loadConfig } from "./config.js";
import { commandFailure, parseJsonOutput, runCommand } from "./process.js";
import { generateDocs, readRequest } from "./docs.js";
import { assertValid } from "./schema.js";
import type { DocsEngine, DocsReport } from "./types.js";

const args = process.argv.slice(2);
const command = args[0];
const repositoryPath = resolve(option("--repo") ?? process.cwd());

try {
  if (command === "init") {
    const result = initConfig(repositoryPath, args.includes("--force"));
    console.log(JSON.stringify(result, null, 2));
    process.exitCode = result.status === "CREATED" ? 0 : 1;
  } else if (command === "plan") {
    const prompt = args[1];
    if (!prompt || prompt.startsWith("--")) throw new Error("Usage: ai-code-docs plan <prompt> --repo <path> [--out <draft.json>]");
    const out = resolve(repositoryPath, option("--out") ?? ".ai-code-docs/drafts/docs.plan.json");
    const result = runCommand(loadConfig(repositoryPath).planner, ["propose", prompt, "--repo", repositoryPath, "--out", out, "--json"], repositoryPath);
    console.log(JSON.stringify(parseJsonOutput<unknown>(result) ?? { status: "BLOCKED", message: commandFailure(result) }, null, 2));
    process.exitCode = result.status === 0 ? 0 : 2;
  } else if (command === "generate") {
    const report = generateDocs({
      repositoryPath,
      requestPath: resolve(repositoryPath, requiredOption("--request")),
      ...(option("--planner-draft") ? { plannerDraftPath: option("--planner-draft")! } : {}),
      ...(option("--worker-plan") ? { workerPlanPath: option("--worker-plan")! } : {}),
      ...(option("--engine") ? { engine: parseEngine(option("--engine")!) } : {}),
      ...(option("--review-engine") ? { reviewEngine: parseEngine(option("--review-engine")!) } : {}),
      ...(option("--out") ? { outputPath: resolve(repositoryPath, option("--out")!) } : {})
    }, loadConfig(repositoryPath));
    console.log(JSON.stringify(report, null, 2));
    process.exitCode = report.status === "DONE" ? 0 : 2;
  } else if (command === "doctor") {
    const config = loadConfig(repositoryPath);
    const control = runCommand(config.control, ["health-check"], repositoryPath);
    const report = { status: control.status === 0 ? "PASS" : "BLOCKED", control: parseJsonOutput<unknown>(control) ?? commandFailure(control), planner: config.planner, worker: config.worker, review: config.review };
    console.log(JSON.stringify(report, null, 2));
    process.exitCode = report.status === "PASS" ? 0 : 2;
  } else if (command === "ingest") {
    const report = JSON.parse(readFileSync(resolve(repositoryPath, requiredOption("--report")), "utf8")) as DocsReport;
    assertValid("docs-report.schema.json", report);
    console.log(JSON.stringify({ status: "DONE", docsStatus: report.status, artifacts: report.artifacts.length, tasks: Object.keys(report.taskCommits).length }, null, 2));
  } else {
    throw new Error("Usage: ai-code-docs <init|plan|generate|doctor|ingest>");
  }
} catch (error) {
  console.error(JSON.stringify({ status: "BLOCKED", message: error instanceof Error ? error.message : String(error) }, null, 2));
  process.exitCode = 2;
}

function option(name: string): string | null {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] ?? null : null;
}

function requiredOption(name: string): string {
  const value = option(name);
  if (!value || value.startsWith("--")) throw new Error(`Missing required option ${name}`);
  return value;
}

function parseEngine(value: string): DocsEngine {
  if (value === "fake" || value === "codex" || value === "claude") return value;
  throw new Error(`Unsupported engine: ${value}`);
}
