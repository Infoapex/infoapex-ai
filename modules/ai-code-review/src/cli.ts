#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { initConfig, loadConfig } from "./config.js";
import { commandFailure, parseJsonOutput, runCommand } from "./process.js";
import { planReview, readRequest, runReview } from "./review.js";
import { assertValid } from "./schema.js";
import type { ReviewEngine, ReviewReport } from "./types.js";

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
    const outputPath = resolve(repositoryPath, option("--out") ?? ".ai-code-review/drafts/review.plan.json");
    if (!prompt || prompt.startsWith("--")) throw new Error("Usage: ai-code-review plan <review prompt> --repo <path> [--out <draft.json>]");
    const result = planReview(repositoryPath, prompt, outputPath, loadConfig(repositoryPath));
    const parsed = parseJsonOutput<unknown>(result);
    console.log(JSON.stringify(parsed ?? { status: result.status === 0 ? "DONE" : "BLOCKED", message: commandFailure(result) }, null, 2));
    process.exitCode = result.status === 0 ? 0 : 2;
  } else if (command === "run") {
    const report = runReview({
      repositoryPath,
      requestPath: resolve(repositoryPath, requiredOption("--request")),
      ...(option("--planner-draft") ? { plannerDraftPath: resolve(repositoryPath, option("--planner-draft")!) } : {}),
      skipPlanner: args.includes("--no-planner"),
      skipControl: args.includes("--no-control"),
      ...(option("--engine") ? { engine: parseEngine(option("--engine")!) } : {}),
      ...(option("--fixture") ? { fixturePath: resolve(repositoryPath, option("--fixture")!) } : {}),
      ...(option("--out") ? { outputPath: resolve(repositoryPath, option("--out")!) } : {})
    }, loadConfig(repositoryPath));
    console.log(JSON.stringify(report, null, 2));
    process.exitCode = report.status === "PASS" ? 0 : 2;
  } else if (command === "ingest") {
    const path = resolve(repositoryPath, requiredOption("--report"));
    const report = JSON.parse(readFileSync(path, "utf8")) as ReviewReport;
    assertValid("review-report.schema.json", report);
    console.log(JSON.stringify({ status: "DONE", reviewStatus: report.status, findings: report.findings.length, blocking: report.findings.filter((finding) => finding.severity === "blocking").length }, null, 2));
  } else if (command === "doctor") {
    const config = loadConfig(repositoryPath);
    const engine = parseEngine(option("--engine") ?? config.defaultEngine);
    const worker = runCommand(config.worker, ["doctor", "--repo", repositoryPath, "--engine", engine, "--json"], repositoryPath);
    const control = runCommand(config.control, ["health-check"], repositoryPath);
    const report = { status: worker.status === 0 && control.status === 0 ? "PASS" : "BLOCKED", worker: parseJsonOutput<unknown>(worker) ?? commandFailure(worker), control: parseJsonOutput<unknown>(control) ?? commandFailure(control) };
    console.log(JSON.stringify(report, null, 2));
    process.exitCode = report.status === "PASS" ? 0 : 2;
  } else {
    throw new Error("Usage: ai-code-review <init|plan|run|ingest|doctor>");
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

function parseEngine(value: string): ReviewEngine {
  if (value === "fake" || value === "codex" || value === "claude") return value;
  throw new Error(`Unsupported review engine: ${value}`);
}
