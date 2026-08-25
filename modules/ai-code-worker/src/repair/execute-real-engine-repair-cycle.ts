import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createWorkerCommit } from "../git/commit.js";
import { currentHead } from "../git/diff.js";
import { createTaskWorktree } from "../git/worktree.js";
import { resolveQualityGate } from "../runner/quality-gate-config.js";
import { runQualityGateSync, type QualityGateResult } from "../runner/quality-gate.js";
import type { EngineUsage } from "../engines/engine-event.js";
import type { AgentExecutionResult } from "../engines/fake-engine.js";
import { buildRepairPrompt } from "./build-repair-prompt.js";
import type { RepairCycleExecutionContext, RepairCycleExecutionResult, RepairCycleExecutor, RepairTaskCycleOutcome } from "./repair-cycle.js";
import type { RepairTask } from "./repair-task.js";

/** The subset of ClaudeCliAdapter/CodexCliAdapter that a repair attempt
 *  needs - both classes already satisfy this (see src/engines/claude-cli.ts,
 *  codex-cli.ts), so neither needs a wrapper class, just this narrower view. */
export interface RepairEngineAdapter {
  start(request: {
    readonly runId: string;
    readonly taskId: string;
    readonly executionId: string;
    readonly sessionId: string;
    readonly worktreePath: string;
    readonly prompt: string;
    readonly startedAt: string;
  }): {
    readonly executionId: string;
    readonly sessionId: string;
    readonly usage: EngineUsage;
    readonly result: AgentExecutionResult;
  };
}

export interface RealEngineRepairExecutorOptions {
  readonly engineName: string;
  readonly adapter: RepairEngineAdapter;
  readonly repositoryPath: string;
  readonly stateRoot: string;
  readonly runId: string;
  readonly manifestSha256: string;
  /** See execute-fake-repair-cycle.ts's identical field for why this has to
   *  be supplied rather than derived: repair tasks never declare
   *  dependsOn, so there is no other commit to branch a repair worktree
   *  from except "wherever the run currently stands". */
  readonly baseCommit: string;
  readonly reviewer: (context: { readonly runId: string; readonly graphVersion: number; readonly taskCommits: Readonly<Record<string, string>> }) => import("../review/independent-review.js").IndependentReviewResult;
  readonly evidenceRoot?: string;
  readonly now?: () => string;
}

/**
 * A real RepairCycleExecutor that dispatches a repair task to an actual
 * engine (Claude Code or Codex CLI) instead of createNoRepairCapabilityExecutor's
 * unconditional FAILED, or execute-fake-repair-cycle.ts's deterministic file
 * write. Same shape as the fake-engine executor (todo.md #9/#13), the only
 * real difference being step 2: instead of writeFakeRepairOutput, the actual
 * adapter.start() call is what's expected to produce the fix, exactly as it
 * does for a normal (non-repair) task in runClaude/runCodex.
 *
 * Deliberately does NOT reuse runClaude/runCodex's dispatch loop - those are
 * 500+ line functions with recovery/checkpoint/event-sequencing state
 * threaded through every step, and extracting a safe single-task primitive
 * from them is separate, larger work (see todo.md #13). This module needs
 * only what ClaudeCliAdapter/CodexCliAdapter already expose publicly
 * (.start()), which independent-reviewer-cli.ts already established as a
 * safe, standalone way to talk to a real engine outside the main loop -
 * this follows that same precedent, not a new one.
 *
 * Like execute-fake-repair-cycle.ts: the engine's own self-reported status
 * is never trusted as the pass/fail signal. After every attempt (whatever
 * the engine claims), the task's own `verify` commands run for real and
 * their exit code decides PASSED vs FAILED - matching exactly how the main
 * per-task loop in runClaude/runCodex already treats a normal task (commit
 * whatever changed, then let task.verify gates be the real arbiter).
 */
export function createRealEngineRepairExecutor(options: RealEngineRepairExecutorOptions): RepairCycleExecutor {
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
  readonly options: RealEngineRepairExecutorOptions;
  readonly now: () => string;
}): RepairTaskCycleOutcome {
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
  const startedAt = input.now();

  const execution = options.adapter.start({
    runId: options.runId,
    taskId: task.id,
    executionId: `${options.runId}-${task.id.toLowerCase()}-repair-${input.cycle}`,
    sessionId: `${options.runId}-${task.id.toLowerCase()}-repair-${input.cycle}-session`,
    worktreePath: worktree.worktree.path,
    prompt: promptResult.prompt,
    startedAt
  });

  writeFileSync(join(evidenceRoot, `cycle-${input.cycle}-agent-result.json`), `${JSON.stringify(execution.result, null, 2)}\n`, "utf8");

  const commit = createWorkerCommit({
    worktreePath: worktree.worktree.path,
    expectedHead,
    runId: options.runId,
    taskId: task.id,
    manifestSha256: options.manifestSha256,
    allowedPaths: task.allowedPaths,
    forbiddenPaths: task.forbiddenPaths,
    message: `Repair ${task.id} (cycle ${input.cycle}, ${options.engineName})`
  });

  if (commit.status === "BLOCKED" || !commit.commit) {
    return {
      taskId: task.id,
      outcome: "BLOCKED",
      commit: null,
      evidenceRef: writeOutcomeEvidence(evidenceRoot, input.cycle, {
        stage: "commit",
        engineResultStatus: execution.result.status,
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
      engineResultStatus: execution.result.status,
      verifyResults
    })
  };
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
