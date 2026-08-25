import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createWorkerCommit } from "../git/commit.js";
import { currentHead } from "../git/diff.js";
import { createTaskWorktree } from "../git/worktree.js";
import { resolveQualityGate } from "../runner/quality-gate-config.js";
import { runQualityGateSync, type QualityGateResult } from "../runner/quality-gate.js";
import type { IndependentReviewResult } from "../review/independent-review.js";
import { buildRepairPrompt } from "./build-repair-prompt.js";
import type { RepairCycleExecutionContext, RepairCycleExecutionResult, RepairCycleExecutor, RepairTaskCycleOutcome } from "./repair-cycle.js";
import type { RepairTask } from "./repair-task.js";

export interface FakeRepairExecutorOptions {
  readonly repositoryPath: string;
  readonly stateRoot: string;
  readonly runId: string;
  readonly manifestSha256: string;
  /** Commit every repair task's worktree branches from. In practice this is
   *  the run's current integrated HEAD after the original tasks committed -
   *  repair tasks have no dependsOn of their own (compileRepairTasks always
   *  sets it to []), so there is no other commit to derive this from. */
  readonly baseCommit: string;
  /** Re-run after each cycle's repair attempts are committed, so the loop
   *  can tell whether the repair actually resolved the review, not just
   *  whether the verify commands the finding itself named happened to pass.
   *  Required, not optional: an executor that skips this and always reports
   *  a clean review would defeat the bounded-repair-loop safety property. */
  readonly reviewer: (context: { readonly runId: string; readonly graphVersion: number; readonly taskCommits: Readonly<Record<string, string>> }) => IndependentReviewResult;
  readonly evidenceRoot?: string;
  readonly now?: () => string;
}

/**
 * A real RepairCycleExecutor for the fake engine (todo.md #9's remaining
 * half - createNoRepairCapabilityExecutor is the deliberate stand-in this
 * replaces for the fake engine specifically). "Real" here means: an actual
 * worktree per repair task, an actual file write standing in for the
 * engine's fix (FakeEngineAdapter itself is a pure event/metadata generator
 * with no filesystem side effects - see src/engines/fake-engine.ts and
 * fake-run.ts's writeFakeTaskOutput), an actual worker commit, and - the
 * part every existing repair test skips by hardcoding outcome: "PASSED" -
 * actually running the RepairTask's own `verify` commands and letting their
 * real exit codes decide PASSED vs FAILED. The task only counts as resolved
 * when its own declared verification says so.
 *
 * Wiring this into claude-run.ts/codex-run.ts (dispatching a repair task to
 * a real engine instead of a deterministic file write) is a separate,
 * comparably-sized follow-up - see todo.md #9. This module establishes the
 * pattern (worktree -> engine -> commit -> real verify -> re-review) against
 * the fake engine first, per HANDOFF-PHASE-3-CLAUDE.md's own recommended
 * sequencing ("Only after deterministic fake coverage is green, exercise
 * the path with real Codex/Claude adapters").
 */
export function createFakeRepairExecutor(options: FakeRepairExecutorOptions): RepairCycleExecutor {
  const now = options.now ?? (() => new Date().toISOString());

  return (context: RepairCycleExecutionContext): RepairCycleExecutionResult => {
    const taskCommits: Record<string, string> = {};
    const taskOutcomes: RepairTaskCycleOutcome[] = [];

    for (const task of context.tasks) {
      const outcome = executeOneRepairTask({
        task,
        findings: context.findings,
        cycle: context.cycle,
        options,
        now
      });

      taskOutcomes.push(outcome);

      if (outcome.outcome === "PASSED" && outcome.commit) {
        taskCommits[task.id] = outcome.commit;
      }
    }

    const reviewAfterCycle = options.reviewer({
      runId: options.runId,
      graphVersion: context.tasks[0]?.graphVersion ?? 1,
      taskCommits
    });

    return { taskOutcomes, reviewAfterCycle };
  };
}

function executeOneRepairTask(input: {
  readonly task: RepairTask;
  readonly findings: RepairCycleExecutionContext["findings"];
  readonly cycle: number;
  readonly options: FakeRepairExecutorOptions;
  readonly now: () => string;
}): RepairCycleExecutionResult["taskOutcomes"][number] {
  const { task, options } = input;
  const evidenceRoot = options.evidenceRoot ?? join(options.stateRoot, "runs", options.runId, "repairs", task.id);
  mkdirSync(evidenceRoot, { recursive: true });

  const promptResult = buildRepairPrompt({ task, findings: input.findings });
  writeFileSync(join(evidenceRoot, `cycle-${input.cycle}-prompt.txt`), promptResult.prompt, "utf8");

  const worktree = createTaskWorktree({
    repositoryPath: options.repositoryPath,
    stateRoot: options.stateRoot,
    runId: options.runId,
    taskId: task.id,
    attempt: input.cycle,
    baseCommit: options.baseCommit
  });

  if (worktree.status === "BLOCKED" || !worktree.worktree) {
    return {
      taskId: task.id,
      outcome: "BLOCKED",
      commit: null,
      evidenceRef: writeOutcomeEvidence(evidenceRoot, input.cycle, {
        stage: "worktree",
        findings: worktree.findings
      })
    };
  }

  const expectedHead = currentHead(worktree.worktree.path);
  writeFakeRepairOutput(worktree.worktree.path, task, input.cycle);

  const commit = createWorkerCommit({
    worktreePath: worktree.worktree.path,
    expectedHead,
    runId: options.runId,
    taskId: task.id,
    manifestSha256: options.manifestSha256,
    allowedPaths: task.allowedPaths,
    forbiddenPaths: task.forbiddenPaths,
    message: `Repair ${task.id} (cycle ${input.cycle})`
  });

  if (commit.status === "BLOCKED" || !commit.commit) {
    return {
      taskId: task.id,
      outcome: "BLOCKED",
      commit: null,
      evidenceRef: writeOutcomeEvidence(evidenceRoot, input.cycle, {
        stage: "commit",
        findings: commit.findings
      })
    };
  }

  const verifyResults = runVerify(task, worktree.worktree.path);
  const verifyPassed = verifyResults.every((result) => result.exitCode === 0 && !result.timedOut);

  return {
    taskId: task.id,
    outcome: verifyPassed ? "PASSED" : "FAILED",
    commit: commit.commit.sha,
    evidenceRef: writeOutcomeEvidence(evidenceRoot, input.cycle, {
      stage: "verify",
      verifyResults
    })
  };
}

/** Deterministic stand-in for what a real engine's fix would write, matching
 *  fake-run.ts's writeFakeTaskOutput pattern (same reasoning: FakeEngineAdapter
 *  has no filesystem side effects of its own). Written into the first
 *  file-shaped allowedPath, since a RepairTask's scope comes from the
 *  findings it resolves rather than a declared expectedArtifacts list. */
function writeFakeRepairOutput(worktreePath: string, task: RepairTask, cycle: number): void {
  const targetPath = task.allowedPaths.find((path) => !path.endsWith("/")) ?? task.allowedPaths[0];

  if (!targetPath) {
    return;
  }

  const absolutePath = join(worktreePath, ...targetPath.split("/"));
  mkdirSync(dirname(absolutePath), { recursive: true });
  const marker = `repair task=${task.id} cycle=${cycle} findings=${task.sourceFindingIds.join(",")}\n`;

  if (existsSync(absolutePath)) {
    writeFileSync(absolutePath, marker, { encoding: "utf8", flag: "a" });
  } else {
    writeFileSync(absolutePath, marker, "utf8");
  }
}

function runVerify(task: RepairTask, worktreePath: string): readonly QualityGateResult[] {
  const results: QualityGateResult[] = [];

  for (const verifyCommand of task.verify) {
    const resolved = resolveQualityGate({
      repositoryRoot: worktreePath,
      executionRoot: worktreePath,
      gate: verifyCommand,
      defaultTimeoutMs: 120_000,
      maximumOutputBytes: 65536
    });

    if (resolved.status === "BLOCKED" || !resolved.command) {
      results.push({
        id: verifyCommand,
        executable: "",
        args: [],
        exitCode: null,
        durationMs: 0,
        timedOut: false,
        outputTruncated: false,
        redacted: false,
        outputSha256: "",
        failureClass: "infrastructure"
      });
      continue;
    }

    results.push(runQualityGateSync(resolved.command));
  }

  return results;
}

function writeOutcomeEvidence(evidenceRoot: string, cycle: number, payload: unknown): string {
  const path = join(evidenceRoot, `cycle-${cycle}-outcome.json`);
  writeFileSync(path, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  return path;
}
