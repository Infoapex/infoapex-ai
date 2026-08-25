import type { RepairCycleExecutor } from "../repair/repair-cycle.js";

/**
 * todo.md #9's other half: real automated repair execution (dispatching a
 * RepairTask to a real engine, in a worktree, committing, re-gating) is not built.
 * Wiring the real reviewer (independent-reviewer-cli.ts) without a real repair
 * executor still needs *some* RepairCycleExecutor, because runRepairCycles() calls it
 * unconditionally once a review has blocking findings. This one reports every task as
 * FAILED and echoes a synthetic "no repair capability" review - so the bounded loop
 * exhausts (or the same-signature repeated-failure check trips) within its existing
 * budget and the run BLOCKS with the real findings, instead of either skipping
 * review-driven repair entirely or silently pretending automated repair exists.
 */
export function createNoRepairCapabilityExecutor(now: () => string = () => new Date().toISOString()): RepairCycleExecutor {
  return (context) => {
    const first = context.tasks[0];
    const runId = first?.runId ?? "unknown-run";
    const graphVersion = first?.graphVersion ?? 1;
    const findingIds = [...new Set(context.tasks.flatMap((task) => task.sourceFindingIds))];

    return {
      taskOutcomes: context.tasks.map((task) => ({
        taskId: task.id,
        outcome: "FAILED" as const,
        commit: null,
        evidenceRef: null
      })),
      reviewAfterCycle: {
        schemaVersion: "1.0",
        runId,
        reviewId: `${runId}-repair-cycle-${context.cycle}-no-executor`,
        reviewer: "no-repair-capability",
        graphVersion,
        createdAt: now(),
        verdict: "fail",
        criterionCoverage: [],
        findings: [
          {
            id: "REV-NO-REPAIR-EXECUTOR",
            severity: "blocking",
            category: "capability-missing",
            criterionIds: [],
            files: [],
            evidence: `Automated repair execution is not implemented yet. ${findingIds.length} original finding(s) remain unresolved: ${findingIds.join(", ") || "none"}.`
          }
        ]
      }
    };
  };
}
