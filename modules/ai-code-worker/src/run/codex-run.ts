import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  resolveUsageCheckpointLogPath,
  UsageCheckpointLog,
  type UsageCheckpointTaskKind,
  type UsageCheckpointTaskRisk
} from "../benchmark/usage-checkpoint.js";
import { loadProjectConfig, type ProjectConfig } from "../config/project-config.js";
import { runCompile, type CompileReport } from "../compile/compile.js";
import { CodexCliAdapter, type CodexCliAdapterConfig } from "../engines/codex-cli.js";
import type { EngineUsage } from "../engines/engine-event.js";
import { createWorkerCommit } from "../git/commit.js";
import { currentHead, git } from "../git/diff.js";
import { createTaskWorktree } from "../git/worktree.js";
import { buildTaskGraph, getTask, type ManifestTask, type TaskRuntimeState } from "../graph/task-graph.js";
import { EventLog } from "../persistence/event-log.js";
import { recoverRunCheckpoints, type RunCheckpoints } from "../persistence/recovery.js";
import {
  addUsage,
  budgetFromManifest,
  emptyUsageTotals,
  evaluateUsageBudget,
  type UsageTotals
} from "../policy/usage-budget.js";
import { writeRunReports } from "../report/run-report.js";
import { writeBlockedReport, writeRepairEvidenceReport } from "../report/export-artifacts.js";
import { resolveQualityGate } from "../runner/quality-gate-config.js";
import { runQualityGateSync, toEvidenceCommand, type QualityGateResult } from "../runner/quality-gate.js";
import { buildCoverageReview } from "../review/coverage-review.js";
import { SchemaRegistry } from "../schema/json-schema.js";
import { buildTaskInputSnapshot, type SnapshotManifest } from "../snapshots/task-input-snapshot.js";
import { buildSemanticTaskInputs, type SemanticTaskInputs } from "../snapshots/semantic-task-inputs.js";
import { runIndependentReviewAndRepair, type IndependentReviewer } from "./independent-review-repair.js";
import type { RepairCycleExecutor } from "../repair/repair-cycle.js";
import { integrateTaskCommits } from "./integration.js";
import type { TaskContext } from "../context-provider/task-context.js";
import type { ContextPackage } from "../context-provider/types.js";
import { executeTaskWithFallback, type RoutedEngine } from "../routing/task-execution.js";
import type { FrozenRoutingSnapshot } from "../routing/routing-policy.js";
import { buildTaskEvidenceTraceability } from "../evidence/task-traceability.js";
import type { ManifestTaskTraceability } from "../manifest/traceability.js";
import { buildSemanticSourceMap, writeSemanticSourceMap } from "../source-map/semantic-source-map.js";

export interface CodexRunOptions {
  readonly repositoryPath: string;
  readonly planPath: string;
  readonly runId?: string;
  readonly now?: string;
  readonly adapterConfig?: Partial<CodexCliAdapterConfig>;
  readonly taskContexts?: Readonly<Record<string, TaskContext>>;
  readonly taskContextPackages?: Readonly<Record<string, ContextPackage>>;
  readonly contextPackageMode?: "enforce";
  readonly semanticTaskInputs?: Readonly<Record<string, SemanticTaskInputs>>;
  /** Optional hook: when the structural coverage review fails, run an
   *  independent review and, if it has blocking findings, attempt bounded
   *  repair before giving up. Omitted by default - existing behavior
   *  (block immediately on review failure) is unchanged when no provider
   *  is given. */
  readonly independentReview?: CodexIndependentReviewIntegration;
}

export interface CodexIndependentReviewIntegration {
  readonly reviewer: IndependentReviewer;
  /** A factory, not a fixed executor - see the identical comment on
   *  ClaudeIndependentReviewIntegration.executeRepairCycle in claude-run.ts;
   *  the reasoning is the same for both engines. */
  readonly executeRepairCycle: (repairBaseCommit: string) => RepairCycleExecutor;
  readonly maximumAttemptsPerTask?: number;
}

export interface CodexRunReport {
  readonly status: "DONE" | "BLOCKED";
  readonly runId: string | null;
  readonly compile: CompileReport;
  readonly executedTasks: readonly string[];
  readonly state: {
    readonly runRoot: string | null;
    readonly eventLogPath: string | null;
    readonly runEvidencePath: string | null;
  };
  readonly taskCommits: Readonly<Record<string, string>>;
  readonly gateResults: readonly QualityGateResult[];
  readonly usageTotals: UsageTotals | null;
  readonly findings: readonly CodexRunFinding[];
}

export interface CodexRunFinding {
  readonly severity: "blocker";
  readonly code: string;
  readonly message: string;
}

export function runCodex(options: CodexRunOptions): CodexRunReport {
  const registry = SchemaRegistry.load();
  const compile = runCompile(options);

  if (compile.status === "BLOCKED" || !compile.runId || !compile.state.runRoot || !compile.state.manifestPath || !compile.state.eventLogPath) {
    return blocked(compile, "COMPILE_BLOCKED", compile.findings[0]?.message ?? "Compile did not pass.");
  }

  const eventLog = new EventLog(compile.state.eventLogPath, registry);
  const currentEvents = eventLog.read().events;
  const manifest = JSON.parse(readFileSync(compile.state.manifestPath, "utf8")) as RunManifest;
  const projectConfig = loadProjectConfig(compile.repository.ok ? compile.repository.worktreeRoot : options.repositoryPath);
  const adapter = new CodexCliAdapter(
    codexConfig({
      ...codexAdapterConfigFromProject(projectConfig),
      timeoutMs: Number(manifest.budgets.maximumTaskMinutes) * 60_000,
      ...options.adapterConfig
    }),
    registry
  );
  const doctor = adapter.doctor();
  const graph = buildTaskGraph(manifest.tasks);
  const recovery = recoverRunCheckpoints(currentEvents);
  const states = new Map<string, TaskRuntimeState>();
  const executedTasks: string[] = [];
  const taskCommits: Record<string, string> = {};
  const evidenceByTask: Record<string, string> = {};
  const gateResults: QualityGateResult[] = [];
  const budget = budgetFromManifest(manifest.budgets);
  const checkpointLog = new UsageCheckpointLog(
    resolveUsageCheckpointLogPath(compile.repository.ok ? compile.repository.worktreeRoot : options.repositoryPath),
    registry
  );
  let usageTotals = emptyUsageTotals;
  let tick = 0;

  if (recovery.terminal === "DONE") {
    return recoveredTerminalRun(compile, graph.topologicalOrder, recovery, "DONE");
  }

  if (recovery.terminal === "BLOCKED") {
    return {
      ...recoveredTerminalRun(compile, graph.topologicalOrder, recovery, "BLOCKED"),
      findings: [
        {
          severity: "blocker",
          code: "RUN_ALREADY_BLOCKED",
          message: recovery.blockedReason ?? `Run ${compile.runId} is already blocked.`
        }
      ]
    };
  }

  const hasPerTaskRouting = manifest.tasks.some((task) => task.routing !== undefined);
  if (doctor.status === "BLOCKED" && !hasPerTaskRouting) {
    return blockRunningRun({
      compile,
      eventLog,
      code: doctor.findings[0]?.code ?? "CODEX_UNAVAILABLE",
      message: doctor.findings[0]?.message ?? "Codex CLI is unavailable.",
      executedTasks,
      taskCommits,
      gateResults,
      usageTotals,
      now: options.now ?? new Date().toISOString()
    });
  }

  for (const taskId of graph.topologicalOrder) {
    const timestamp = timestampAt(options.now ?? new Date().toISOString(), tick);
    const taskRoot = join(compile.state.runRoot, "tasks", taskId);
    const task = getTask(graph, taskId) as RunManifestTask;
    const checkpoint = recovery.tasks[taskId];

    if (checkpoint?.finishedCommit) {
      states.set(taskId, { status: "PASSED", commit: checkpoint.finishedCommit });
      taskCommits[taskId] = checkpoint.finishedCommit;
      evidenceByTask[taskId] = `tasks/${taskId}/evidence.json`;
      executedTasks.push(taskId);
      usageTotals = addUsage(usageTotals, unknownUsage());
      tick += 1;
      continue;
    }

    const snapshot = buildTaskInputSnapshot({
      manifest,
      taskId,
      states,
      registry,
      semanticInputs:
        options.semanticTaskInputs?.[taskId] ??
        buildSemanticTaskInputs({
          repositoryRoot: compile.repository.ok ? compile.repository.worktreeRoot : options.repositoryPath,
          task: { ...task, verify: [...task.verify, ...manifest.globalGates] },
          contextPackage: options.taskContextPackages?.[taskId],
          projectConfig
        })
    });

    if (checkpoint?.committedCommit && checkpoint.worktreePath) {
      const recovered = continueFromCommittedTask({
        compile,
        eventLog,
        task,
        taskRoot,
        worktreePath: checkpoint.worktreePath,
        expectedCommit: checkpoint.committedCommit,
        timestamp,
        taskId,
        states,
        executedTasks,
        taskCommits,
        evidenceByTask,
        gateResults,
        usageTotals,
        engineVersion: doctor.version
      });

      if (recovered.status === "BLOCKED") {
        return recovered.report;
      }

      usageTotals = recovered.usageTotals;
      tick += 1;
      continue;
    }

    const worktree = createTaskWorktree({
      repositoryPath: compile.repository.ok ? compile.repository.worktreeRoot : options.repositoryPath,
      stateRoot: stateRootFromRunRoot(compile.state.runRoot),
      runId: compile.runId,
      taskId,
      attempt: 1,
      baseCommit: manifest.base.commit
    });

    if (worktree.status === "BLOCKED" || !worktree.worktree) {
      return blockRunningRun({
        compile,
        eventLog,
        code: worktree.findings[0]?.code ?? "WORKTREE_CREATE_FAILED",
        message: worktree.findings[0]?.message ?? "Could not create task worktree.",
        executedTasks,
        taskCommits,
        gateResults,
        usageTotals,
        now: timestamp
      });
    }

    for (const dependency of snapshot.transitiveDependencies) {
      git(["cherry-pick", "--no-gpg-sign", dependency.commit], worktree.worktree.path);
    }

    const expectedHead = currentHead(worktree.worktree.path);

    const contextPackage = options.taskContextPackages?.[taskId];
    if (contextPackage) {
      eventLog.append({
        eventId: `${compile.runId}-${String(eventLog.read().events.length).padStart(4, "0")}-${taskId}-context-compiled`,
        runId: compile.runId,
        type: "task.context-compiled",
        createdAt: timestamp,
        payload: {
          taskId,
          contextDigest: contextPackage.contextDigest,
          packageId: contextPackage.packageId,
          mode: options.contextPackageMode ?? "enforce",
          consumedByEngine: true
        }
      });
    }

    const candidates = task.routing?.candidates ?? [{ engine: "codex" as const, model: options.adapterConfig?.defaultModel ?? null }];
    const taskExecution = executeTaskWithFallback({
      candidates,
      projectConfig,
      request: {
        runId: compile.runId,
        taskId,
        executionId: `${compile.runId}-${taskId.toLowerCase()}-attempt-1`,
        sessionId: `${compile.runId}-${taskId.toLowerCase()}-session`,
        worktreePath: worktree.worktree.path,
        prompt: codexPrompt({
          manifest,
          task,
          taskId,
          snapshot,
          context: options.taskContexts?.[taskId],
          contextPackage: options.taskContextPackages?.[taskId]
        }),
        startedAt: timestamp
      },
      codexOverrides: options.adapterConfig
    });
    const execution = taskExecution.execution;
    const activeEngine = taskExecution.candidate.engine;
    const activeVersion = activeEngine === "codex" ? doctor.version : null;

    checkpointLog.append({
      checkpointId: `${compile.runId}-${taskId}-start`,
      runId: compile.runId,
      taskId,
      scope: "task",
      engine: activeEngine,
      phase: "start",
      createdAt: timestamp,
      taskKind: task.kind,
      taskRisk: task.risk,
      model: taskExecution.candidate.model
    });

    checkpointLog.append({
      checkpointId: `${compile.runId}-${taskId}-end`,
      runId: compile.runId,
      taskId,
      scope: "task",
      engine: activeEngine,
      phase: "end",
      createdAt: timestamp,
      taskKind: task.kind,
      taskRisk: task.risk,
      model: taskExecution.candidate.model,
      tokens: execution.usage
    });

    mkdirSync(taskRoot, { recursive: true });
    writeJson(join(taskRoot, "task-input.json"), snapshot);
    writeJson(join(taskRoot, "engine-events.json"), taskExecution.attempts.flatMap((attempt) => attempt.execution.events));
    writeJson(join(taskRoot, "agent-result.json"), execution.result);

    eventLog.append({
      eventId: `${compile.runId}-${String(eventLog.read().events.length).padStart(4, "0")}-${taskId}-input-frozen`,
      runId: compile.runId,
      type: "task.input-frozen",
      createdAt: timestamp,
      payload: { taskId, snapshotMetadataSha256: snapshot.snapshotMetadataSha256 }
    });
    eventLog.append({
      eventId: `${compile.runId}-${String(eventLog.read().events.length).padStart(4, "0")}-${taskId}-worktree-created`,
      runId: compile.runId,
      type: "task.worktree-created",
      createdAt: timestamp,
      payload: {
        taskId,
        path: worktree.worktree.path,
        branch: worktree.worktree.branch,
        headCommit: worktree.worktree.headCommit,
        inputHead: expectedHead
      }
    });
    eventLog.append({
      eventId: `${compile.runId}-${String(eventLog.read().events.length).padStart(4, "0")}-${taskId}-started`,
      runId: compile.runId,
      type: "task.started",
      createdAt: timestamp,
      payload: { taskId, executionId: execution.executionId, sessionId: execution.sessionId }
    });

    if (execution.result.runId !== compile.runId || execution.result.taskId !== taskId) {
      return blockRunningRun({
        compile,
        eventLog,
        code: "ENGINE_RESULT_MISMATCH",
        message: `Codex result identity does not match task ${taskId}.`,
        executedTasks,
        taskCommits,
        gateResults,
        usageTotals,
        now: timestamp
      });
    }

    if (execution.result.status !== "DONE") {
      return blockRunningRun({
        compile,
        eventLog,
        code: "ENGINE_TASK_FAILED",
        message: execution.result.failures[0]?.message ?? `Codex did not complete task ${taskId}.`,
        executedTasks,
        taskCommits,
        gateResults,
        usageTotals,
        now: timestamp
      });
    }

    const commit = createWorkerCommit({
      worktreePath: worktree.worktree.path,
      expectedHead,
      runId: compile.runId,
      taskId,
      manifestSha256: compile.manifestSha256!,
      allowedPaths: task.allowedPaths,
      forbiddenPaths: task.forbiddenPaths,
      message: `Implement ${taskId}`
    });

    if (commit.status === "BLOCKED" || !commit.commit) {
      return blockRunningRun({
        compile,
        eventLog,
        code: commit.findings[0]?.code ?? "TASK_COMMIT_FAILED",
        message: commit.findings[0]?.message ?? `Could not commit task ${taskId}.`,
        executedTasks,
        taskCommits,
        gateResults,
        usageTotals,
        now: timestamp
      });
    }

    const taskCommit = commit.commit.sha;
    writeJson(join(taskRoot, "commit.json"), commit.commit);
    eventLog.append({
      eventId: `${compile.runId}-${String(eventLog.read().events.length).padStart(4, "0")}-${taskId}-committed`,
      runId: compile.runId,
      type: "task.committed",
      createdAt: timestamp,
      payload: { taskId, commit: taskCommit, parent: commit.commit.parent, changedPaths: commit.changedPaths }
    });

    const taskGateReport = runGates({
      compile,
      eventLog,
      gates: task.verify,
      repositoryRoot: compile.repository.ok ? compile.repository.worktreeRoot : options.repositoryPath,
      executionRoot: worktree.worktree.path,
      scope: `task:${taskId}`,
      taskId,
      defaultTimeoutMs: Number(manifest.budgets.maximumTaskMinutes) * 60_000,
      now: timestamp
    });
    gateResults.push(...taskGateReport.results);
    writeJson(join(taskRoot, "evidence.json"), evidenceFor(compile.runId, activeEngine, activeVersion, execution.usage, taskGateReport.results, task));
    evidenceByTask[taskId] = `tasks/${taskId}/evidence.json`;

    if (taskGateReport.status === "BLOCKED") {
      return blockRunningRun({
        compile,
        eventLog,
        code: taskGateReport.finding?.code ?? "TASK_GATE_FAILED",
        message: taskGateReport.finding?.message ?? `Task gate failed for ${taskId}.`,
        executedTasks,
        taskCommits,
        gateResults,
        usageTotals,
        now: timestamp
      });
    }

    eventLog.append({
      eventId: `${compile.runId}-${String(eventLog.read().events.length).padStart(4, "0")}-${taskId}-finished`,
      runId: compile.runId,
      type: "task.finished",
      createdAt: timestamp,
      payload: { taskId, status: execution.result.status, commit: taskCommit }
    });

    states.set(taskId, { status: "PASSED", commit: taskCommit });
    taskCommits[taskId] = taskCommit;
    executedTasks.push(taskId);
    usageTotals = addUsage(usageTotals, execution.usage);

    const budgetEvaluation = evaluateUsageBudget(usageTotals, budget);
    if (budgetEvaluation.status === "BLOCK") {
      const finding = budgetEvaluation.findings.find((candidate) => candidate.severity === "blocker")!;
      const runEvidencePath = join(compile.state.runRoot, "run-evidence.json");

      writeJson(runEvidencePath, aggregateEvidenceFor(compile.runId, "codex", doctor.version, usageTotals, gateResults));
      eventLog.append({
        eventId: `${compile.runId}-${String(eventLog.read().events.length).padStart(4, "0")}-run-blocked`,
        runId: compile.runId,
        type: "run.blocked",
        createdAt: timestamp,
        payload: { code: finding.code, reason: finding.message, field: finding.field }
      });
      writeRunReports({
        compile,
        status: "BLOCKED",
        engine: "codex",
        taskCommits,
        gateResults,
        usageTotals,
        blockedReason: finding.message
      });

      return {
        status: "BLOCKED",
        runId: compile.runId,
        compile,
        executedTasks,
        state: {
          runRoot: compile.state.runRoot,
          eventLogPath: compile.state.eventLogPath,
          runEvidencePath
        },
        taskCommits,
        gateResults,
        usageTotals,
        findings: [{ severity: "blocker", code: finding.code, message: finding.message }]
      };
    }

    tick += 1;
  }

  const runEvidencePath = join(compile.state.runRoot, "run-evidence.json");
  const lastTaskId = graph.topologicalOrder.at(-1);
  const lastTaskRoot = lastTaskId ? join(stateRootFromRunRoot(compile.state.runRoot), "worktrees", compile.runId, lastTaskId, "attempt-1") : compile.repository.ok ? compile.repository.worktreeRoot : options.repositoryPath;
  const globalGateReport = runGates({
    compile,
    eventLog,
    gates: manifest.globalGates,
    repositoryRoot: compile.repository.ok ? compile.repository.worktreeRoot : options.repositoryPath,
    executionRoot: lastTaskRoot,
    scope: "global",
    taskId: null,
    defaultTimeoutMs: Number(manifest.budgets.maximumRunMinutes) * 60_000,
    now: timestampAt(options.now ?? new Date().toISOString(), tick)
  });
  gateResults.push(...globalGateReport.results);
  writeJson(runEvidencePath, aggregateEvidenceFor(compile.runId, "codex", doctor.version, usageTotals, gateResults));

  if (globalGateReport.status === "BLOCKED") {
    return blockRunningRun({
      compile,
      eventLog,
      code: globalGateReport.finding?.code ?? "GLOBAL_GATE_FAILED",
      message: globalGateReport.finding?.message ?? "Global gate failed.",
      executedTasks,
      taskCommits,
      gateResults,
      usageTotals,
      now: timestampAt(options.now ?? new Date().toISOString(), tick)
    });
  }

  const reviewPath = join(compile.state.runRoot, "review.json");
  const review = buildCoverageReview({
    runId: compile.runId,
    reviewer: "deterministic-read-only",
    tasks: manifest.tasks,
    evidenceByTask,
    registry
  });
  writeJson(reviewPath, review);
  eventLog.append({
    eventId: `${compile.runId}-${String(eventLog.read().events.length).padStart(4, "0")}-review-finished`,
    runId: compile.runId,
    type: "review.finished",
    createdAt: timestampAt(options.now ?? new Date().toISOString(), tick),
    payload: {
      status: review.status,
      path: reviewPath,
      findings: review.findings.length,
      coverageRows: review.coverageMatrix.length
    }
  });

  if (review.status !== "PASS") {
    if (!options.independentReview) {
      return blockRunningRun({
        compile,
        eventLog,
        code: "REVIEW_FAILED",
        message: review.findings[0]?.message ?? "Read-only review did not pass.",
        executedTasks,
        taskCommits,
        gateResults,
        usageTotals,
        now: timestampAt(options.now ?? new Date().toISOString(), tick)
      });
    }

    // See the identical comment above runClaude's repairBaseWorktree/
    // repairBaseIntegration block in claude-run.ts - same reasoning, same
    // shape, applies unchanged to the Codex engine.
    const repairBaseWorktree = createTaskWorktree({
      repositoryPath: compile.repository.ok ? compile.repository.worktreeRoot : options.repositoryPath,
      stateRoot: stateRootFromRunRoot(compile.state.runRoot),
      runId: compile.runId,
      taskId: "__repair_base__",
      attempt: 1,
      baseCommit: manifest.base.commit,
      recreateIfExists: true
    });

    if (repairBaseWorktree.status === "BLOCKED" || !repairBaseWorktree.worktree) {
      return blockRunningRun({
        compile,
        eventLog,
        code: repairBaseWorktree.findings[0]?.code ?? "REPAIR_BASE_WORKTREE_FAILED",
        message: repairBaseWorktree.findings[0]?.message ?? "Could not create the repair base worktree.",
        executedTasks,
        taskCommits,
        gateResults,
        usageTotals,
        now: timestampAt(options.now ?? new Date().toISOString(), tick)
      });
    }

    const repairBaseIntegration = integrateTaskCommits({
      worktreePath: repairBaseWorktree.worktree.path,
      baseCommit: manifest.base.commit,
      orderedTaskIds: graph.topologicalOrder,
      taskCommits: new Map(Object.entries(taskCommits))
    });

    if (repairBaseIntegration.status === "BLOCKED" && repairBaseIntegration.conflictReport) {
      const conflictReportPath = join(compile.state.runRoot, "repair-base-conflict-report.json");
      writeJson(conflictReportPath, repairBaseIntegration.conflictReport);

      return blockRunningRun({
        compile,
        eventLog,
        code: "REPAIR_BASE_INTEGRATION_CONFLICT",
        message: `Could not build a combined repair base: conflict on task ${repairBaseIntegration.conflictReport.taskId} commit ${repairBaseIntegration.conflictReport.commit}: ${repairBaseIntegration.conflictReport.conflictedPaths.join(", ") || "unknown paths"}. See repair-base-conflict-report.json.`,
        executedTasks,
        taskCommits,
        gateResults,
        usageTotals,
        now: timestampAt(options.now ?? new Date().toISOString(), tick)
      });
    }

    const repairBaseCommit = currentHead(repairBaseWorktree.worktree.path);

    const repairOutcome = runIndependentReviewAndRepair({
      runId: compile.runId,
      graphVersion: manifest.graphVersion,
      taskCommits,
      maximumRepairCycles: Number(manifest.budgets.maximumRepairCycles ?? 0),
      maximumAttemptsPerTask: options.independentReview.maximumAttemptsPerTask ?? 1,
      reviewer: options.independentReview.reviewer,
      executeRepairCycle: options.independentReview.executeRepairCycle(repairBaseCommit),
      registry,
      now: timestampAt(options.now ?? new Date().toISOString(), tick)
    });

    eventLog.append({
      eventId: `${compile.runId}-${String(eventLog.read().events.length).padStart(4, "0")}-repair-budget-initialized`,
      runId: compile.runId,
      type: "repair.budget-initialized",
      createdAt: timestampAt(options.now ?? new Date().toISOString(), tick),
      payload: { maximumRepairCycles: Number(manifest.budgets.maximumRepairCycles ?? 0) }
    });

    if (repairOutcome.repairResult) {
      for (const attempt of repairOutcome.repairResult.attempts) {
        eventLog.append({
          eventId: `${compile.runId}-${String(eventLog.read().events.length).padStart(4, "0")}-${attempt.id}`,
          runId: compile.runId,
          type: attempt.outcome === "PASSED" ? "repair.attempt-finished" : "repair.attempt-started",
          createdAt: timestampAt(options.now ?? new Date().toISOString(), tick),
          payload: { repairTaskId: attempt.repairTaskId, cycle: attempt.cycle, outcome: attempt.outcome }
        });
      }

      writeRepairEvidenceReport({
        runRoot: compile.state.runRoot,
        runId: compile.runId,
        budget: repairOutcome.repairResult.budget,
        tasks: repairOutcome.repairResult.compiledTasks,
        attempts: repairOutcome.repairResult.attempts
      });
    }

    if (repairOutcome.status !== "DONE") {
      eventLog.append({
        eventId: `${compile.runId}-${String(eventLog.read().events.length).padStart(4, "0")}-repair-cycle-exhausted`,
        runId: compile.runId,
        type: "repair.cycle-exhausted",
        createdAt: timestampAt(options.now ?? new Date().toISOString(), tick),
        payload: { stopReason: repairOutcome.repairResult?.budget.stopReason ?? null }
      });

      return blockRunningRun({
        compile,
        eventLog,
        code: "REPAIR_DID_NOT_RESOLVE_REVIEW",
        message: `Independent review kept finding blocking issues after repair: ${repairOutcome.repairResult?.budget.stopReason ?? "unknown reason"}.`,
        executedTasks,
        taskCommits,
        gateResults,
        usageTotals,
        now: timestampAt(options.now ?? new Date().toISOString(), tick),
        repairUnresolvedFindingIds: repairOutcome.repairResult?.unresolvedFindingIds ?? []
      });
    }
  }

  const sourceMap = buildSemanticSourceMap({
    runRoot: compile.state.runRoot,
    manifest,
    manifestSha256: compile.manifestSha256!,
    taskCommits,
    events: eventLog.read().events,
    createdAt: timestampAt(options.now ?? new Date().toISOString(), tick),
    registry
  });
  if (sourceMap) {
    writeSemanticSourceMap(compile.state.runRoot, sourceMap);
    eventLog.append({
      eventId: `${compile.runId}-${String(eventLog.read().events.length).padStart(4, "0")}-source-map-generated`,
      runId: compile.runId,
      type: "source-map.generated",
      createdAt: timestampAt(options.now ?? new Date().toISOString(), tick),
      payload: { sourceMapDigest: sourceMap.sourceMapDigest, traceCoveragePercent: sourceMap.coverage.traceCoveragePercent, complete: sourceMap.coverage.complete }
    });
    if (!sourceMap.coverage.complete) {
      return blockRunningRun({
        compile,
        eventLog,
        code: "SOURCE_MAP_ENFORCEMENT_FAILED",
        message: `Semantic source-map coverage is incomplete: ${sourceMap.coverage.criteriaWithDirectEvidence}/${sourceMap.coverage.criteriaTotal} criteria; ${sourceMap.findings.map((finding) => finding.code).join(", ")}.`,
        executedTasks,
        taskCommits,
        gateResults,
        usageTotals,
        now: timestampAt(options.now ?? new Date().toISOString(), tick)
      });
    }
  }

  writeRunReports({
    compile,
    status: "DONE",
    engine: "codex",
    taskCommits,
    gateResults,
    usageTotals,
    blockedReason: null
  });

  eventLog.append({
    eventId: `${compile.runId}-${String(eventLog.read().events.length).padStart(4, "0")}-run-done`,
    runId: compile.runId,
    type: "run.done",
    createdAt: timestampAt(options.now ?? new Date().toISOString(), tick),
    payload: { tasks: executedTasks }
  });

  return {
    status: "DONE",
    runId: compile.runId,
    compile,
    executedTasks,
    state: {
      runRoot: compile.state.runRoot,
      eventLogPath: compile.state.eventLogPath,
      runEvidencePath
    },
    taskCommits,
    gateResults,
    usageTotals,
    findings: []
  };
}

interface RunManifest extends SnapshotManifest {
  readonly schemaVersion: "1.0" | "1.1";
  readonly goal: string;
  readonly budgets: Record<string, unknown>;
  readonly globalGates: readonly string[];
  readonly tasks: readonly RunManifestTask[];
}

interface RunManifestTask extends ManifestTask {
  readonly kind: UsageCheckpointTaskKind;
  readonly risk: UsageCheckpointTaskRisk;
  readonly requiredInputs: readonly string[];
  readonly allowedPaths: readonly string[];
  readonly forbiddenPaths: readonly string[];
  readonly expectedArtifacts: readonly string[];
  readonly acceptanceCriteria: readonly string[];
  readonly verify: readonly string[];
  readonly executionProfile?: string;
  readonly routing?: FrozenRoutingSnapshot;
  readonly traceability?: ManifestTaskTraceability;
}

export function codexConfig(overrides: Partial<CodexCliAdapterConfig> = {}): CodexCliAdapterConfig {
  return {
    requiresCapabilitySmokeTest: true,
    // Local Windows pilot note: codex-cli 0.146.0-alpha.3.1 currently reports
    // workspace-write as read-only for exec file writes. The worker still enforces
    // allowedPaths/forbiddenPaths before creating the worker-owned commit.
    sandboxMode: "danger-full-access",
    ...overrides
  };
}

export function codexAdapterConfigFromProject(config: ProjectConfig | null): Partial<CodexCliAdapterConfig> {
  const source = config?.adapters?.codex;

  return {
    ...(source?.executable !== undefined ? { executable: source.executable } : {}),
    ...(source?.model !== undefined ? { defaultModel: source.model } : {}),
    ...(source?.reasoningEffort !== undefined ? { reasoningEffort: source.reasoningEffort } : {}),
    ...(source?.sandboxMode !== undefined ? { sandboxMode: source.sandboxMode } : {}),
    ...(source?.timeoutSeconds !== undefined ? { timeoutMs: source.timeoutSeconds * 1000 } : {}),
    ...(source?.maximumOutputBytes !== undefined ? { maximumOutputBytes: source.maximumOutputBytes } : {}),
    ...(source?.testedVersionRanges !== undefined ? { testedVersionRanges: source.testedVersionRanges } : {})
  };
}

function codexPrompt(input: {
  readonly manifest: RunManifest;
  readonly task: RunManifestTask;
  readonly taskId: string;
  readonly snapshot: ReturnType<typeof buildTaskInputSnapshot>;
  readonly context?: TaskContext;
  readonly contextPackage?: ContextPackage;
}): string {
  return `${JSON.stringify(
    {
      runId: input.snapshot.runId,
      taskId: input.taskId,
      workerInstructions: [
        "You are executing inside ai-code-worker, not an interactive coding agent session.",
        "Treat this JSON task envelope and its allowedPaths/forbiddenPaths as the active task scope.",
        "Do not broaden scope, push, deploy, or edit files outside allowedPaths.",
        "First read the required inputs and make the actual file changes needed to satisfy every acceptance criterion.",
        "Only once all file edits are complete, respond with your final message containing ONLY a single JSON " +
          "object and nothing else - no markdown fences, no prose before or after it - matching exactly this shape: " +
          '{"schemaVersion":"1.0","runId":<runId>,"taskId":<taskId>,"status":"DONE"|"FAILED"|"BLOCKED",' +
          '"summary":<string>,"touchedFiles":[<string>...],' +
          '"failures":[{"class":"deterministic"|"flaky"|"infrastructure"|"policy"|"engine","message":<string>}...]}'
      ],
      goal: input.manifest.goal,
      allowedPaths: input.task.allowedPaths,
      forbiddenPaths: input.task.forbiddenPaths,
      requiredInputs: input.task.requiredInputs,
      expectedArtifacts: input.task.expectedArtifacts,
      acceptanceCriteria: input.task.acceptanceCriteria,
      verify: input.task.verify,
      directDependencies: input.snapshot.directDependencies,
      transitiveDependencies: input.snapshot.transitiveDependencies,
      ...(input.context ? { contextProviderContext: input.context } : {}),
      ...(input.contextPackage
        ? {
            contextPackagePolicy: "Use only renderedContent from this validated package as external repository context. Authority and omissions are enforceable metadata.",
            contextPackage: input.contextPackage
          }
        : {})
    },
    null,
    2
  )}\n`;
}

function evidenceFor(
  runId: string,
  engine: RoutedEngine,
  engineVersion: string | null,
  usage: EngineUsage,
  commands: readonly QualityGateResult[],
  task: RunManifestTask
): unknown {
  const inputTotal =
    usage.inputUncachedTokens === null &&
    usage.cacheReadTokens === null &&
    usage.cacheWriteTokens === null
      ? null
      : (usage.inputUncachedTokens ?? 0) + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0);

  const taskTraceability = buildTaskEvidenceTraceability(task, commands);
  return {
    schemaVersion: taskTraceability ? "1.1" : "1.0",
    runId,
    engine: {
      name: engine,
      version: engineVersion ?? "unknown",
      adapterVersion: "0.1.0"
    },
    input: {
      uncachedTokens: usage.inputUncachedTokens,
      cacheReadTokens: usage.cacheReadTokens,
      cacheWriteTokens: usage.cacheWriteTokens,
      totalReportedTokens: inputTotal
    },
    output: {
      standardTokens: usage.outputTokens,
      reasoningTokens: null,
      totalReportedTokens: usage.outputTokens
    },
    cost: {
      reportedCostUsd: usage.costUsd,
      estimatedCostUsd: null,
      currency: null
    },
    commands: commands.map(toEvidenceCommand),
    artifacts: [],
    ...(taskTraceability ? { taskTraceability } : {})
  };
}

function aggregateEvidenceFor(
  runId: string,
  engine: RoutedEngine,
  engineVersion: string | null,
  totals: UsageTotals,
  commands: readonly QualityGateResult[] = []
): unknown {
  const inputTotal =
    totals.inputUncachedTokens === null && totals.cacheReadTokens === null && totals.cacheWriteTokens === null
      ? null
      : (totals.inputUncachedTokens ?? 0) + (totals.cacheReadTokens ?? 0) + (totals.cacheWriteTokens ?? 0);

  return {
    schemaVersion: "1.0",
    runId,
    engine: {
      name: engine,
      version: engineVersion ?? "unknown",
      adapterVersion: "0.1.0"
    },
    input: {
      uncachedTokens: totals.inputUncachedTokens,
      cacheReadTokens: totals.cacheReadTokens,
      cacheWriteTokens: totals.cacheWriteTokens,
      totalReportedTokens: inputTotal
    },
    output: {
      standardTokens: totals.outputTokens,
      reasoningTokens: null,
      totalReportedTokens: totals.outputTokens
    },
    cost: {
      reportedCostUsd: totals.costUsd,
      estimatedCostUsd: null,
      currency: null
    },
    commands: commands.map(toEvidenceCommand),
    artifacts: []
  };
}

function continueFromCommittedTask(input: {
  readonly compile: CompileReport;
  readonly eventLog: EventLog;
  readonly task: RunManifestTask;
  readonly taskRoot: string;
  readonly worktreePath: string;
  readonly expectedCommit: string;
  readonly timestamp: string;
  readonly taskId: string;
  readonly states: Map<string, TaskRuntimeState>;
  readonly executedTasks: string[];
  readonly taskCommits: Record<string, string>;
  readonly evidenceByTask: Record<string, string>;
  readonly gateResults: QualityGateResult[];
  readonly usageTotals: UsageTotals;
  readonly engineVersion: string | null;
}):
  | { readonly status: "PASS"; readonly usageTotals: UsageTotals }
  | { readonly status: "BLOCKED"; readonly report: CodexRunReport } {
  if (currentHead(input.worktreePath) !== input.expectedCommit) {
    return {
      status: "BLOCKED",
      report: blockRunningRun({
        compile: input.compile,
        eventLog: input.eventLog,
        code: "RECOVERY_AMBIGUOUS",
        message: `Task ${input.taskId} worktree HEAD does not match the recorded commit.`,
        executedTasks: input.executedTasks,
        taskCommits: input.taskCommits,
        gateResults: input.gateResults,
        usageTotals: input.usageTotals,
        now: input.timestamp
      })
    };
  }

  mkdirSync(input.taskRoot, { recursive: true });
  const taskGateReport = runGates({
    compile: input.compile,
    eventLog: input.eventLog,
    gates: input.task.verify,
    repositoryRoot: input.compile.repository.ok ? input.compile.repository.worktreeRoot : input.worktreePath,
    executionRoot: input.worktreePath,
    scope: `task:${input.taskId}`,
    taskId: input.taskId,
    defaultTimeoutMs: 60_000,
    now: input.timestamp
  });
  input.gateResults.push(...taskGateReport.results);
  writeJson(
    join(input.taskRoot, "evidence.json"),
    evidenceFor(input.compile.runId!, "codex", input.engineVersion, unknownUsage(), taskGateReport.results, input.task)
  );
  input.evidenceByTask[input.taskId] = `tasks/${input.taskId}/evidence.json`;

  if (taskGateReport.status === "BLOCKED") {
    return {
      status: "BLOCKED",
      report: blockRunningRun({
        compile: input.compile,
        eventLog: input.eventLog,
        code: taskGateReport.finding?.code ?? "TASK_GATE_FAILED",
        message: taskGateReport.finding?.message ?? `Task gate failed for ${input.taskId}.`,
        executedTasks: input.executedTasks,
        taskCommits: input.taskCommits,
        gateResults: input.gateResults,
        usageTotals: input.usageTotals,
        now: input.timestamp
      })
    };
  }

  input.eventLog.append({
    eventId: `${input.compile.runId}-${String(input.eventLog.read().events.length).padStart(4, "0")}-${input.taskId}-finished`,
    runId: input.compile.runId!,
    type: "task.finished",
    createdAt: input.timestamp,
    payload: { taskId: input.taskId, status: "DONE", commit: input.expectedCommit }
  });

  input.states.set(input.taskId, { status: "PASSED", commit: input.expectedCommit });
  input.taskCommits[input.taskId] = input.expectedCommit;
  input.executedTasks.push(input.taskId);

  return {
    status: "PASS",
    usageTotals: addUsage(input.usageTotals, unknownUsage())
  };
}

function recoveredTerminalRun(
  compile: CompileReport,
  taskOrder: readonly string[],
  recovery: RunCheckpoints,
  status: "DONE" | "BLOCKED"
): CodexRunReport {
  let usageTotals = emptyUsageTotals;
  const taskCommits: Record<string, string> = {};
  const executedTasks: string[] = [];

  for (const taskId of taskOrder) {
    const commit = recovery.tasks[taskId]?.finishedCommit ?? recovery.tasks[taskId]?.committedCommit;
    if (commit) {
      taskCommits[taskId] = commit;
      executedTasks.push(taskId);
      usageTotals = addUsage(usageTotals, unknownUsage());
    }
  }

  return {
    status,
    runId: compile.runId,
    compile,
    executedTasks,
    state: {
      runRoot: compile.state.runRoot,
      eventLogPath: compile.state.eventLogPath,
      runEvidencePath: compile.state.runRoot ? join(compile.state.runRoot, "run-evidence.json") : null
    },
    taskCommits,
    gateResults: [],
    usageTotals,
    findings: []
  };
}

function blocked(compile: CompileReport, code: string, message: string): CodexRunReport {
  return {
    status: "BLOCKED",
    runId: compile.runId,
    compile,
    executedTasks: [],
    state: {
      runRoot: compile.state.runRoot,
      eventLogPath: compile.state.eventLogPath,
      runEvidencePath: null
    },
    taskCommits: {},
    gateResults: [],
    usageTotals: null,
    findings: [{ severity: "blocker", code, message }]
  };
}

function blockRunningRun(input: {
  readonly compile: CompileReport;
  readonly eventLog: EventLog;
  readonly code: string;
  readonly message: string;
  readonly executedTasks: readonly string[];
  readonly taskCommits: Readonly<Record<string, string>>;
  readonly gateResults: readonly QualityGateResult[];
  readonly usageTotals: UsageTotals;
  readonly now: string;
  readonly repairUnresolvedFindingIds?: readonly string[];
}): CodexRunReport {
  input.eventLog.append({
    eventId: `${input.compile.runId}-${String(input.eventLog.read().events.length).padStart(4, "0")}-run-blocked`,
    runId: input.compile.runId!,
    type: "run.blocked",
    createdAt: input.now,
    payload: { code: input.code, reason: input.message }
  });
  writeRunReports({
    compile: input.compile,
    status: "BLOCKED",
    engine: "codex",
    taskCommits: input.taskCommits,
    gateResults: input.gateResults,
    usageTotals: input.usageTotals,
    blockedReason: input.message
  });

  if (input.compile.state.runRoot) {
    writeBlockedReport({
      runRoot: input.compile.state.runRoot,
      runId: input.compile.runId!,
      cause: `${input.code}: ${input.message}`,
      lastSafeState:
        input.executedTasks.length === 0
          ? "No tasks completed before this run was blocked."
          : `Tasks completed and committed: ${input.executedTasks.join(", ")}.`,
      evidencePaths:
        input.repairUnresolvedFindingIds && input.repairUnresolvedFindingIds.length > 0
          ? ["repairs/repair-evidence.md", ...input.repairUnresolvedFindingIds.map((id) => `finding: ${id}`)]
          : ["run-evidence.json"],
      resumeInstructions: `Resolve the cause above, then re-run with the same --run-id ${input.compile.runId}. Already-committed tasks are not re-executed.`
    });
  }

  return {
    status: "BLOCKED",
    runId: input.compile.runId,
    compile: input.compile,
    executedTasks: input.executedTasks,
    state: {
      runRoot: input.compile.state.runRoot,
      eventLogPath: input.compile.state.eventLogPath,
      runEvidencePath: null
    },
    taskCommits: input.taskCommits,
    gateResults: input.gateResults,
    usageTotals: input.usageTotals,
    findings: [{ severity: "blocker", code: input.code, message: input.message }]
  };
}

function runGates(input: {
  readonly compile: CompileReport;
  readonly eventLog: EventLog;
  readonly gates: readonly string[];
  readonly repositoryRoot: string;
  readonly executionRoot: string;
  readonly scope: string;
  readonly taskId: string | null;
  readonly defaultTimeoutMs: number;
  readonly now: string;
}): {
  readonly status: "PASS" | "BLOCKED";
  readonly results: readonly QualityGateResult[];
  readonly finding: CodexRunFinding | null;
} {
  const results: QualityGateResult[] = [];

  for (const gate of input.gates) {
    const resolved = resolveQualityGate({
      repositoryRoot: input.repositoryRoot,
      executionRoot: input.executionRoot,
      gate,
      defaultTimeoutMs: input.defaultTimeoutMs,
      maximumOutputBytes: 65536
    });

    if (resolved.status === "BLOCKED" || !resolved.command) {
      return {
        status: "BLOCKED",
        results,
        finding: {
          severity: "blocker",
          code: resolved.finding?.code ?? "QUALITY_GATE_NOT_FOUND",
          message: resolved.finding?.message ?? `Could not resolve quality gate ${gate}.`
        }
      };
    }

    input.eventLog.append({
      eventId: `${input.compile.runId}-${String(input.eventLog.read().events.length).padStart(4, "0")}-${input.scope}-${resolved.command.id}-gate-started`,
      runId: input.compile.runId!,
      type: "gate.started",
      createdAt: input.now,
      payload: { gateId: resolved.command.id, taskId: input.taskId, scope: input.scope }
    });

    const result = runQualityGateSync(resolved.command);
    results.push(result);

    input.eventLog.append({
      eventId: `${input.compile.runId}-${String(input.eventLog.read().events.length).padStart(4, "0")}-${input.scope}-${resolved.command.id}-gate-finished`,
      runId: input.compile.runId!,
      type: "gate.finished",
      createdAt: input.now,
      payload: {
        gateId: result.id,
        taskId: input.taskId,
        scope: input.scope,
        exitCode: result.exitCode,
        failureClass: result.failureClass,
        outputSha256: result.outputSha256
      }
    });

    if (result.failureClass) {
      return {
        status: "BLOCKED",
        results,
        finding: {
          severity: "blocker",
          code: input.taskId ? "TASK_GATE_FAILED" : "GLOBAL_GATE_FAILED",
          message: `${input.scope} gate ${result.id} failed with ${result.failureClass}.`
        }
      };
    }
  }

  return {
    status: "PASS",
    results,
    finding: null
  };
}

function unknownUsage(): EngineUsage {
  return {
    inputUncachedTokens: null,
    cacheReadTokens: null,
    cacheWriteTokens: null,
    outputTokens: null,
    costUsd: null
  };
}

function stateRootFromRunRoot(runRoot: string): string {
  return dirname(dirname(runRoot));
}

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function timestampAt(start: string, seconds: number): string {
  return new Date(Date.parse(start) + seconds * 1000).toISOString();
}
