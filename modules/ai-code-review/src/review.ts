import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertValid } from "./schema.js";
import { commandFailure, parseJsonOutput, runCommand } from "./process.js";
import type { CommandResult, ReviewConfig, ReviewEngine, ReviewReport, ReviewRequest } from "./types.js";

interface PlannerState {
  readonly status: "PASS" | "SKIPPED" | "BLOCKED";
  readonly draftPath?: string;
  readonly message?: string;
}

interface ControlState {
  readonly status: "PASS" | "SKIPPED" | "BLOCKED";
  readonly health?: string;
  readonly brief?: string;
  readonly impact?: string;
  readonly message?: string;
}

interface WorkerRawResult {
  readonly status?: "DONE" | "BLOCKED";
  readonly engine?: string;
  readonly review?: {
    readonly verdict?: "pass" | "fail";
    readonly criterionCoverage?: ReviewReport["coverage"];
    readonly findings?: ReviewReport["findings"];
  };
  readonly message?: string;
}

export interface RunReviewOptions {
  readonly repositoryPath: string;
  readonly requestPath: string;
  readonly plannerDraftPath?: string;
  readonly skipPlanner?: boolean;
  readonly skipControl?: boolean;
  readonly engine?: ReviewEngine;
  readonly fixturePath?: string;
  readonly outputPath?: string;
}

export function readRequest(path: string): ReviewRequest {
  const request = JSON.parse(readFileSync(path, "utf8")) as ReviewRequest;
  assertValid("review-request.schema.json", request);
  return request;
}

export function runReview(options: RunReviewOptions, config: ReviewConfig): ReviewReport {
  const request = readRequest(options.requestPath);
  const planner = runPlannerReview(options, config, request);
  const control = options.skipControl ? { status: "SKIPPED" as const } : runControlReview(options.repositoryPath, config, request);

  const temporaryRoot = mkdtempSync(join(tmpdir(), "ai-code-review-"));
  const workerInput = join(temporaryRoot, "request.json");
  const enrichedRequest = { ...request, graphVersion: request.graphVersion ?? 1, controlContext: control.brief ?? "" };
  writeFileSync(workerInput, `${JSON.stringify(enrichedRequest, null, 2)}\n`, "utf8");

  let worker: ReviewReport["worker"];
  let coverage: ReviewReport["coverage"] = [];
  let findings: ReviewReport["findings"] = [];

  try {
    const engine = options.engine ?? config.defaultEngine;
    const args = ["review", "--repo", options.repositoryPath, "--input", workerInput, "--engine", engine, "--json"];
    if (options.fixturePath) args.push("--fixture", options.fixturePath);
    const result = runCommand(config.worker, args, options.repositoryPath);
    const raw = parseJsonOutput<WorkerRawResult>(result);
    if (result.status !== 0 || !raw || raw.status !== "DONE" || !raw.review) {
      worker = { status: "BLOCKED", engine, message: commandFailure(result) };
    } else {
      coverage = raw.review.criterionCoverage ?? [];
      findings = raw.review.findings ?? [];
      worker = { status: "PASS", engine, verdict: raw.review.verdict };
    }
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }

  const blocked = planner.status === "BLOCKED" || control.status === "BLOCKED" || worker.status === "BLOCKED";
  const failed = worker.verdict === "fail" || findings.some((finding) => finding.severity === "blocking" || finding.severity === "major");
  const report: ReviewReport = {
    schemaVersion: "1.0",
    runId: request.runId,
    reviewId: request.reviewId,
    status: blocked ? "BLOCKED" : failed ? "FAIL" : "PASS",
    planner,
    control,
    worker,
    coverage,
    findings
  };
  assertValid("review-report.schema.json", report);
  if (options.outputPath) writeFileSync(options.outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  return report;
}

function runPlannerReview(options: RunReviewOptions, config: ReviewConfig, request: ReviewRequest): PlannerState {
  if (options.skipPlanner) return { status: "SKIPPED", message: "Planner validation was explicitly disabled." };
  if (!options.plannerDraftPath) return { status: "BLOCKED", message: "A planner draft is required; use --planner-draft or explicitly pass --no-planner." };
  const result = runCommand(config.planner, ["inspect", options.plannerDraftPath, "--json"], options.repositoryPath);
  const parsed = parseJsonOutput<{ schemaValid?: boolean; lintOk?: boolean }>(result);
  if (result.status !== 0 || !parsed?.schemaValid || !parsed.lintOk) {
    return { status: "BLOCKED", draftPath: options.plannerDraftPath, message: commandFailure(result) };
  }
  return { status: "PASS", draftPath: options.plannerDraftPath, message: `Planner draft validated for ${request.reviewId}.` };
}

function runControlReview(repositoryPath: string, config: ReviewConfig, request: ReviewRequest): ControlState {
  const health = runCommand(config.control, ["health-check"], repositoryPath);
  const brief = runCommand(config.control, ["memory-brief", `Review ${request.reviewId}`], repositoryPath);
  const impacts: string[] = [];
  for (const symbol of request.symbols ?? []) {
    const result = runCommand(config.control, ["impact-analysis", symbol], repositoryPath);
    impacts.push(`${symbol}: ${result.status === 0 ? result.stdout.trim() : commandFailure(result)}`);
  }
  if (health.status !== 0 || brief.status !== 0) {
    return { status: "BLOCKED", health: health.stdout.trim(), brief: brief.stdout.trim(), impact: impacts.join("\n"), message: commandFailure(health.status !== 0 ? health : brief) };
  }
  return { status: "PASS", health: health.stdout.trim(), brief: brief.stdout.trim(), impact: impacts.join("\n") };
}

export function planReview(repositoryPath: string, prompt: string, outputPath: string, config: ReviewConfig): CommandResult {
  return runCommand(config.planner, ["propose", prompt, "--repo", repositoryPath, "--out", outputPath, "--json"], repositoryPath);
}
