import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { assertValid } from "./schema.js";
import { commandFailure, parseJsonOutput, runCommand } from "./process.js";
import type { CommandResult, DocsConfig, DocsEngine, DocsReport, DocsRequest, DocsStage } from "./types.js";

export interface GenerateDocsOptions {
  readonly repositoryPath: string;
  readonly requestPath: string;
  readonly plannerDraftPath?: string;
  readonly workerPlanPath?: string;
  readonly engine?: DocsEngine;
  readonly reviewEngine?: DocsEngine;
  readonly outputPath?: string;
}

interface WorkerResult {
  readonly status?: "DONE" | "BLOCKED";
  readonly taskCommits?: Record<string, string>;
  readonly findings?: readonly unknown[];
}

interface ReviewResult { readonly status?: "PASS" | "FAIL" | "BLOCKED"; }

export function readRequest(path: string): DocsRequest {
  const request = JSON.parse(readFileSync(path, "utf8")) as DocsRequest;
  assertValid("docs-request.schema.json", request);
  return request;
}

export function generateDocs(options: GenerateDocsOptions, config: DocsConfig): DocsReport {
  const request = readRequest(options.requestPath);
  const draftPath = options.plannerDraftPath ?? request.plannerDraftPath;
  const planner = runPlanner(options.repositoryPath, config, draftPath, request);
  const control = runControl(options.repositoryPath, config, request);
  const temporaryRoot = mkdtempSync(join(tmpdir(), "ai-code-docs-"));
  const taskCommits: Record<string, string> = {};
  let worker: DocsReport["worker"] = { status: "BLOCKED", message: "Worker was not started." };
  let review: DocsStage = { status: "BLOCKED", message: "Review was not started." };
  let planPath: string | undefined;

  try {
    if (planner.status === "PASS") {
      const planResult = ensureWorkerPlan({ options, config, request, draftPath: draftPath!, temporaryRoot });
      planPath = planResult.path;
      if (planResult.result.status !== 0 || !planPath) {
        worker = { status: "BLOCKED", message: commandFailure(planResult.result), path: planPath };
      } else {
        const engine = options.engine ?? config.defaultEngine;
        const result = runCommand(config.worker, ["run", "--repo", options.repositoryPath, "--plan", planPath, "--engine", engine, "--run-id", request.runId, "--json"], options.repositoryPath);
        const raw = parseJsonOutput<WorkerResult>(result);
        if (result.status !== 0 || raw?.status !== "DONE") {
          worker = { status: "BLOCKED", message: commandFailure(result), path: planPath, engine };
        } else {
          Object.assign(taskCommits, raw.taskCommits ?? {});
          worker = { status: "PASS", path: planPath, engine, taskCommits };
        }
      }
    }

    if (planner.status === "PASS" && control.status === "PASS" && worker.status === "PASS") {
      const reviewRequestPath = join(temporaryRoot, "review-request.json");
      writeFileSync(reviewRequestPath, `${JSON.stringify({
        schemaVersion: "1.0",
        runId: request.runId,
        reviewId: `${request.docsId}-review`,
        baseCommit: request.baseCommit,
        headCommit: request.headCommit,
        criteria: request.criteria,
        symbols: request.symbols,
        controlContext: control.message ?? ""
      }, null, 2)}\n`, "utf8");
      const reviewArgs = ["run", "--repo", options.repositoryPath, "--request", reviewRequestPath, "--planner-draft", draftPath!, "--engine", options.reviewEngine ?? config.defaultReviewEngine, "--json"];
      if (request.reviewFixturePath) reviewArgs.push("--fixture", resolve(options.repositoryPath, request.reviewFixturePath));
      const result = runCommand(config.review, reviewArgs, options.repositoryPath);
      const raw = parseJsonOutput<ReviewResult>(result);
      review = result.status === 0 && raw?.status === "PASS"
        ? { status: "PASS", engine: options.reviewEngine ?? config.defaultReviewEngine, verdict: "pass" }
        : { status: "BLOCKED", engine: options.reviewEngine ?? config.defaultReviewEngine, message: commandFailure(result) };
    }
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }

  const done = planner.status === "PASS" && control.status === "PASS" && worker.status === "PASS" && review.status === "PASS";
  const report: DocsReport = {
    schemaVersion: "1.0",
    runId: request.runId,
    docsId: request.docsId,
    status: done ? "DONE" : "BLOCKED",
    planner,
    control,
    worker,
    review,
    artifacts: planPath ? [planPath, ...request.outputPaths] : [...request.outputPaths],
    taskCommits,
    ...(done ? {} : { message: "Documentation generation did not complete all planner, control, worker and review stages." })
  };
  assertValid("docs-report.schema.json", report);
  if (options.outputPath) writeFileSync(options.outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  return report;
}

function runPlanner(repositoryPath: string, config: DocsConfig, draftPath: string | undefined, request: DocsRequest): DocsStage {
  if (!draftPath || !existsSync(resolve(repositoryPath, draftPath))) return { status: "BLOCKED", message: "A planner draft is required for documentation generation." };
  const result = runCommand(config.planner, ["inspect", resolve(repositoryPath, draftPath), "--json"], repositoryPath);
  const parsed = parseJsonOutput<{ schemaValid?: boolean; lintOk?: boolean }>(result);
  return result.status === 0 && parsed?.schemaValid && parsed.lintOk
    ? { status: "PASS", path: resolve(repositoryPath, draftPath), message: `Planner draft validated for ${request.docsId}.` }
    : { status: "BLOCKED", path: resolve(repositoryPath, draftPath), message: commandFailure(result) };
}

function runControl(repositoryPath: string, config: DocsConfig, request: DocsRequest): DocsStage {
  const health = runCommand(config.control, ["health-check"], repositoryPath);
  const brief = runCommand(config.control, ["memory-brief", `Docs ${request.docsId}`], repositoryPath);
  if (health.status !== 0 || brief.status !== 0) return { status: "BLOCKED", message: commandFailure(health.status !== 0 ? health : brief) };
  return { status: "PASS", message: brief.stdout.trim() };
}

function ensureWorkerPlan(input: { options: GenerateDocsOptions; config: DocsConfig; request: DocsRequest; draftPath: string; temporaryRoot: string }): { path?: string; result: CommandResult } {
  if (input.options.workerPlanPath || input.request.workerPlanPath) {
    const path = resolve(input.options.repositoryPath, input.options.workerPlanPath ?? input.request.workerPlanPath!);
    return { path, result: { status: existsSync(path) ? 0 : 2, stdout: "", stderr: existsSync(path) ? "" : `Worker plan not found: ${path}` } };
  }
  const path = resolve(input.options.repositoryPath, "Plan", `${input.request.docsId}.md`);
  mkdirSync(join(input.options.repositoryPath, "Plan"), { recursive: true });
  const result = runCommand(input.config.planner, ["compile", resolve(input.options.repositoryPath, input.draftPath), "--task-id", input.request.docsId, "--out", path, "--repo", input.options.repositoryPath, "--base-engine", input.options.engine ?? input.config.defaultEngine, "--json"], input.options.repositoryPath);
  return { path, result };
}
