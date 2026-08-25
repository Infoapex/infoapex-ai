import { ingestIndependentReview } from "../review/ingest-review.js";
import type { IndependentReviewResult } from "../review/independent-review.js";
import { runRepairCycles, type RepairCycleExecutor, type RepairCycleResult } from "../repair/repair-cycle.js";
import { SchemaRegistry } from "../schema/json-schema.js";

export interface IndependentReviewContext {
  readonly runId: string;
  readonly graphVersion: number;
  readonly taskCommits: Readonly<Record<string, string>>;
}

export type IndependentReviewer = (context: IndependentReviewContext) => IndependentReviewResult;

export interface RunIndependentReviewAndRepairInput {
  readonly runId: string;
  readonly graphVersion: number;
  /** Mutated in place: a PASSED repair attempt's commit is recorded here,
   *  keyed by the repair task id, so the caller's final report/integration
   *  step sees it alongside the original tasks' commits. */
  readonly taskCommits: Record<string, string>;
  readonly maximumRepairCycles: number;
  readonly maximumAttemptsPerTask: number;
  readonly reviewer: IndependentReviewer;
  readonly executeRepairCycle: RepairCycleExecutor;
  readonly registry?: SchemaRegistry;
  readonly now?: string;
}

export interface RunIndependentReviewAndRepairResult {
  readonly status: "DONE" | "BLOCKED";
  readonly initialReview: IndependentReviewResult;
  readonly finalReview: IndependentReviewResult;
  /** null when the initial review already had no blocking findings - no
   *  repair cycle ever ran. */
  readonly repairResult: RepairCycleResult | null;
}

/**
 * The reusable "run an independent review, and if it has blocking findings,
 * run the bounded repair loop" wiring shared by fake-run.ts, claude-run.ts,
 * and codex-run.ts. Deliberately engine-agnostic: both the reviewer and the
 * repair-cycle executor are injected, so this function contains no
 * engine-specific worktree/commit/gate logic of its own - that stays with
 * each runner's existing per-task execution code, reused by the caller's
 * executeRepairCycle implementation.
 */
export function runIndependentReviewAndRepair(input: RunIndependentReviewAndRepairInput): RunIndependentReviewAndRepairResult {
  const registry = input.registry ?? SchemaRegistry.load();
  const initialReview = input.reviewer({ runId: input.runId, graphVersion: input.graphVersion, taskCommits: input.taskCommits });
  const ingestion = ingestIndependentReview(initialReview);

  if (ingestion.blockingFindings.length === 0) {
    return { status: "DONE", initialReview, finalReview: initialReview, repairResult: null };
  }

  const repairResult = runRepairCycles({
    runId: input.runId,
    graphVersion: input.graphVersion,
    maximumRepairCycles: input.maximumRepairCycles,
    maximumAttemptsPerTask: input.maximumAttemptsPerTask,
    initialReview,
    executeCycle: input.executeRepairCycle,
    now: input.now,
    registry
  });

  for (const attempt of repairResult.attempts) {
    if (attempt.outcome === "PASSED" && attempt.commit) {
      input.taskCommits[attempt.repairTaskId] = attempt.commit;
    }
  }

  return {
    status: repairResult.status,
    initialReview,
    finalReview: repairResult.finalReview,
    repairResult
  };
}
