import { sha256 } from "../manifest/normalize.js";
import { compileRepairTasks } from "./compile-repair-tasks.js";
import { ingestIndependentReview } from "../review/ingest-review.js";
import type { IngestedFinding } from "../review/ingest-review.js";
import type { IndependentReviewResult } from "../review/independent-review.js";
import { SchemaRegistry } from "../schema/json-schema.js";
import type { RepairAttempt } from "./repair-attempt.js";
import type { RepairBudget, RepairBudgetStopReason } from "./repair-budget.js";
import type { RepairTask } from "./repair-task.js";
import type { RepeatedFailureSignature } from "./repeated-failure-signature.js";

export interface RepairTaskCycleOutcome {
  readonly taskId: string;
  readonly outcome: "PASSED" | "FAILED" | "BLOCKED";
  readonly commit: string | null;
  readonly evidenceRef: string | null;
}

export interface RepairCycleExecutionContext {
  readonly cycle: number;
  readonly tasks: readonly RepairTask[];
  /** The blocking findings this cycle's tasks were compiled from
   *  (compileRepairTasks' input) - an executor building a real repair prompt
   *  (see buildRepairPrompt) needs the finding evidence, not just the
   *  already-derived task scope, so this is threaded through rather than
   *  requiring every executor to re-derive it from IDs alone. */
  readonly findings: readonly IngestedFinding[];
}

export interface RepairCycleExecutionResult {
  /** One outcome per task, same order as RepairCycleExecutionContext.tasks. */
  readonly taskOutcomes: readonly RepairTaskCycleOutcome[];
  /** Review re-run once for the whole batch after this cycle's tasks executed
   *  (IMPLEMENTATION-PLAN.md §11.6 step 9: rerun gates after each repair batch,
   *  not after every individual task). */
  readonly reviewAfterCycle: IndependentReviewResult;
}

export type RepairCycleExecutor = (context: RepairCycleExecutionContext) => RepairCycleExecutionResult;

export interface RepairCycleInput {
  readonly runId: string;
  readonly graphVersion: number;
  readonly maximumRepairCycles: number;
  readonly maximumAttemptsPerTask: number;
  readonly initialReview: IndependentReviewResult;
  readonly executeCycle: RepairCycleExecutor;
  readonly now?: string;
  readonly registry?: SchemaRegistry;
}

export interface RepairCycleResult {
  readonly status: "DONE" | "BLOCKED";
  readonly budget: RepairBudget;
  readonly attempts: readonly RepairAttempt[];
  readonly signatures: readonly RepeatedFailureSignature[];
  readonly finalReview: IndependentReviewResult;
  readonly unresolvedFindingIds: readonly string[];
  /** Every repair task compiled across every cycle, in compilation order -
   *  for reporting (e.g. writeRepairEvidenceReport), not scheduling. */
  readonly compiledTasks: readonly RepairTask[];
}

/**
 * The bounded REPAIRING loop (state machine states from
 * IMPLEMENTATION-PLAN.md §10.1, budget rules from §11.6): compile repair
 * tasks for the current blocking findings, execute one batch via the
 * injected executor, re-review, and repeat until either no blocking
 * findings remain (DONE), maximumRepairCycles is exhausted, or the same
 * finding shows up with byte-identical evidence across two consecutive
 * cycles - "repeated failure without progress" - which stops the loop
 * early regardless of remaining budget.
 *
 * This module is intentionally standalone: it does not call into
 * fake-run.ts / claude-run.ts / codex-run.ts. Wiring it into those
 * orchestrators' review step is deferred - see todo.md.
 */
export function runRepairCycles(input: RepairCycleInput): RepairCycleResult {
  const registry = input.registry ?? SchemaRegistry.load();
  const now = input.now ?? new Date().toISOString();
  const attempts: RepairAttempt[] = [];
  const compiledTasks: RepairTask[] = [];
  const signaturesById = new Map<string, RepeatedFailureSignature>();

  let currentReview = input.initialReview;
  let cycle = 1;
  let cyclesExecuted = 0;
  let status: "DONE" | "BLOCKED" | null = null;
  let stopReason: RepairBudgetStopReason = null;

  while (cycle <= input.maximumRepairCycles) {
    const ingestion = ingestIndependentReview(currentReview);

    if (ingestion.blockingFindings.length === 0) {
      status = "DONE";
      break;
    }

    const compilation = compileRepairTasks({
      runId: input.runId,
      graphVersion: input.graphVersion,
      blockingFindings: ingestion.blockingFindings,
      criterionCoverage: currentReview.criterionCoverage,
      maximumAttempts: input.maximumAttemptsPerTask,
      now,
      registry
    });

    if (compilation.tasks.length === 0) {
      // Blocking findings remain but none compiled into an actionable task
      // (e.g. no verification command covers their criteria) - the loop
      // cannot make progress automatically, same terminal condition as a
      // repeated failure.
      status = "BLOCKED";
      stopReason = "repeated-failure-no-progress";
      break;
    }

    compiledTasks.push(...compilation.tasks);
    const execution = input.executeCycle({ cycle, tasks: compilation.tasks, findings: ingestion.blockingFindings });
    cyclesExecuted += 1;
    const outcomeByTaskId = new Map(execution.taskOutcomes.map((outcome) => [outcome.taskId, outcome]));

    for (const task of compilation.tasks) {
      const outcome = outcomeByTaskId.get(task.id);
      const attempt: RepairAttempt = {
        schemaVersion: "1.0",
        id: `${task.id}-cycle-${cycle}`,
        repairTaskId: task.id,
        runId: input.runId,
        cycle,
        startedAt: now,
        finishedAt: now,
        outcome: outcome?.outcome ?? "BLOCKED",
        commit: outcome?.commit ?? null,
        failureSignatureId: null,
        evidenceRef: outcome?.evidenceRef ?? null
      };

      registry.assertValid("repair-attempt.schema.json", attempt);
      attempts.push(attempt);
    }

    const nextIngestion = ingestIndependentReview(execution.reviewAfterCycle);
    const progressed = updateSignatures(signaturesById, nextIngestion.blockingFindings, input.runId, now);

    currentReview = execution.reviewAfterCycle;

    if (nextIngestion.blockingFindings.length === 0) {
      status = "DONE";
      break;
    }

    if (!progressed) {
      status = "BLOCKED";
      stopReason = "repeated-failure-no-progress";
      break;
    }

    cycle += 1;
  }

  if (status === null) {
    status = "BLOCKED";
    stopReason = "cycles-exhausted";
  }

  const consumedCycles = cyclesExecuted;
  const budget: RepairBudget = {
    schemaVersion: "1.0",
    runId: input.runId,
    maximumRepairCycles: input.maximumRepairCycles,
    consumedCycles,
    remainingCycles: Math.max(input.maximumRepairCycles - consumedCycles, 0),
    stopReason: status === "DONE" ? null : stopReason,
    updatedAt: now
  };

  registry.assertValid("repair-budget.schema.json", budget);

  const finalIngestion = ingestIndependentReview(currentReview);

  return {
    status,
    budget,
    attempts,
    signatures: [...signaturesById.values()],
    finalReview: currentReview,
    unresolvedFindingIds: finalIngestion.blockingFindings.map((finding) => finding.id),
    compiledTasks
  };
}

/**
 * Updates the per-finding repeated-failure signature map in place and
 * returns whether this cycle made any progress at all: at least one
 * currently-blocking finding either newly appeared or changed its
 * evidence since the last cycle it was seen in. If every still-blocking
 * finding has byte-identical evidence to its previous sighting, the
 * repair attempt changed nothing and the loop should stop early.
 */
function updateSignatures(
  signaturesById: Map<string, RepeatedFailureSignature>,
  blockingFindings: readonly { readonly id: string; readonly evidence: string }[],
  runId: string,
  now: string
): boolean {
  let progressed = false;

  for (const finding of blockingFindings) {
    const hash = sha256(finding.evidence);
    const existing = signaturesById.get(finding.id);

    if (!existing) {
      signaturesById.set(finding.id, {
        schemaVersion: "1.0",
        id: `sig-${finding.id}-${hash.slice(0, 8)}`,
        runId,
        sourceType: "finding",
        sourceId: finding.id,
        signatureHash: hash,
        occurrenceCount: 1,
        firstSeenAt: now,
        lastSeenAt: now,
        progressDetected: true
      });
      progressed = true;
      continue;
    }

    if (existing.signatureHash === hash) {
      signaturesById.set(finding.id, {
        ...existing,
        occurrenceCount: existing.occurrenceCount + 1,
        lastSeenAt: now,
        progressDetected: false
      });
      continue;
    }

    signaturesById.set(finding.id, {
      ...existing,
      signatureHash: hash,
      occurrenceCount: existing.occurrenceCount + 1,
      lastSeenAt: now,
      progressDetected: true
    });
    progressed = true;
  }

  return progressed;
}
