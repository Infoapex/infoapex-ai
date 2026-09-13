import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  resolveUsageCheckpointLogPath,
  UsageCheckpointLog,
  type UsageCheckpointTaskKind,
  type UsageCheckpointTaskRisk
} from "../benchmark/usage-checkpoint.js";
import { loadProjectConfig, type ProjectConfig } from "../config/project-config.js";
import { loadExecutionProfile, runCompile, type CompileReport } from "../compile/compile.js";
import { ClaudeCliAdapter, type ClaudeCliAdapterConfig } from "../engines/claude-cli.js";
import type { EngineUsage } from "../engines/engine-event.js";
import { createWorkerCommit } from "../git/commit.js";
import { currentHead, git } from "../git/diff.js";
import { createTaskWorktree, taskWorktreePath } from "../git/worktree.js";
import { buildTaskGraph, getTask, type ManifestTask, type TaskRuntimeState } from "../graph/task-graph.js";
import { EventLog } from "../persistence/event-log.js";
import { createRunTelemetry } from "../telemetry/run-telemetry.js";
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
import { resolveExecutionEnvironment, type EnvironmentCapabilityReport, type ExecutionEnvironment } from "../execution/environment.js";
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
import { NormalizedUsageAccumulator, type UsageSample } from "../usage/normalized-usage.js";

export interface ClaudeRunOptions {
  readonly repositoryPath: string;
  readonly planPath: string;
  readonly runId?: string;
  readonly now?: string;
  readonly adapterConfig?: Partial<ClaudeCliAdapterConfig>;
  readonly taskContexts?: Readonly<Record<string, TaskContext>>;
  readonly taskContextPackages?: Readonly<Record<string, ContextPackage>>;
  readonly contextPackageMode?: "enforce";
  readonly semanticTaskInputs?: Readonly<Record<string, SemanticTaskInputs>>;
  /** Optional hook: when the structural coverage review fails, run an
   *  independent review and, if it has blocking findings, attempt bounded
   *  repair before giving up. Omitted by default - existing behavior
   *  (block immediately on review failure) is unchanged when no provider
   *  is given. */
  readonly independentReview?: ClaudeIndependentReviewIntegration;
  /** Explicit dependency injection for deterministic contract tests. Production
   * callers must use the resolved, configured execution backend. */
  readonly executionEnvironment?: ExecutionEnvironment;
}

export interface ClaudeIndependentReviewIntegration {
  readonly reviewer: IndependentReviewer;
  /** A factory, not a fixed executor: a repair task branches from the
   *  *combined* state of every task committed so far (runClaude has no
   *  single "integration branch" the way fake-run.ts's parallel-writer path
   *  does - each task lands on its own isolated commit), and that combined
   *  commit only exists once runClaude integrates it right before calling
   *  this, so it cannot be known by the caller ahead of time. */
  readonly executeRepairCycle: (repairBaseCommit: string) => RepairCycleExecutor;
  readonly maximumAttemptsPerTask?: number;
}

export interface ClaudeRunReport {
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
  readonly findings: readonly ClaudeRunFinding[];
}

export interface ClaudeRunFinding {
  readonly severity: "blocker";
  readonly code: string;
  readonly message: string;
}

export async function runClaude(options: ClaudeRunOptions): Promise<ClaudeRunReport> {
  const registry = SchemaRegistry.load();
  const compile = runCompile(options);

  if (compile.status === "BLOCKED" || !compile.runId || !compile.state.runRoot || !compile.state.manifestPath || !compile.state.eventLogPath) {
    return blocked(compile, "COMPILE_BLOCKED", compile.findings[0]?.message ?? "Compile did not pass.");
  }

  const telemetry = createRunTelemetry({ runId: compile.runId, runRoot: compile.state.runRoot, registry });
  const eventLog = new EventLog(compile.state.eventLogPath, registry, telemetry);
  const currentEvents = eventLog.read().events;
  const manifest = JSON.parse(readFileSync(compile.state.manifestPath, "utf8")) as RunManifest;
  const projectConfig = loadProjectConfig(compile.repository.ok ? compile.repository.worktreeRoot : options.repositoryPath);
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
  const usageAccumulator = new NormalizedUsageAccumulator();
  let usageTotals = emptyUsageTotals;
  let tick = 0;

  let executionProfile: unknown;
  let executionEnvironment: ReturnType<typeof resolveExecutionEnvironment>;
  let environmentReport: ReturnType<ReturnType<typeof resolveExecutionEnvironment>["doctor"]>;
  try {
    executionProfile = loadExecutionProfile(compile.repository.ok ? compile.repository.worktreeRoot : options.repositoryPath);
    executionEnvironment = options.executionEnvironment ?? resolveExecutionEnvironment(executionProfile, registry);
    environmentReport = executionEnvironment.doctor(executionProfile);
  } catch {
    return blockRunningRun({
      compile,
      eventLog,
      code: "ENVIRONMENT_CONFIG_INVALID",
      message: "The configured execution environment could not be loaded or validated.",
      executedTasks,
      taskCommits,
      gateResults,
      usageTotals,
      now: options.now ?? new Date().toISOString()
    });
  }
  if (!environmentReport.supported || !environmentReport.providerSupported) {
    const detail = [...environmentReport.warnings, ...environmentReport.providerWarnings].join(" ") || environmentReport.missingCapabilities.join(", ");
    return blockRunningRun({
      compile,
      eventLog,
      code: "ENVIRONMENT_UNAVAILABLE",
      message: `The configured execution environment is unavailable${detail ? `: ${detail}` : "."}`,
      executedTasks,
      taskCommits,
      gateResults,
      usageTotals,
      now: options.now ?? new Date().toISOString()
    });
  }

  const providerProcessRunner = executionEnvironment.providerProcessRunner?.(executionProfile, "claude") ?? null;
  if (!providerProcessRunner) {
    return blockRunningRun({
      compile,
      eventLog,
      code: "ENVIRONMENT_UNAVAILABLE",
      message: "The configured execution environment does not provide an isolated Claude process runner.",
      executedTasks,
      taskCommits,
      gateResults,
      usageTotals,
      now: options.now ?? new Date().toISOString()
    });
  }

  const adapter = new ClaudeCliAdapter(
    claudeConfig({
      ...claudeAdapterConfigFromProject(projectConfig),
      ...options.adapterConfig,
      processRunner: providerProcessRunner
    }),
    registry
  );
  const doctor = adapter.doctor();

  const recordUsageSamples = (samples: readonly UsageSample[]): UsageTotals => {
    if (samples.length > 0) {
      usageTotals = usageAccumulator.addMany(samples).totals;
    }
    return usageTotals;
  };

  if (recovery.terminal === "DONE") {
    return recoveredTerminalRun(compile, graph.topologicalOrder, recovery, "DONE", "claude");
  }

  if (recovery.terminal === "BLOCKED") {
    return {
      ...recoveredTerminalRun(compile, graph.topologicalOrder, recovery, "BLOCKED", "claude"),
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
      code: doctor.findings[0]?.code ?? "CLAUDE_UNAVAILABLE",
      message: doctor.findings[0]?.message ?? "Claude Code CLI is unavailable.",
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
      recordUsageSamples(readUsageSamplesFromEvidence(taskRoot, "claude", taskId));
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
        recordUsageSamples,
        engineVersion: doctor.version,
        environmentReport
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

    const candidates = task.routing?.candidates ?? [{ engine: "claude" as const, model: options.adapterConfig?.defaultModel ?? null }];
    const taskExecution = await executeTaskWithFallback({
      candidates,
      projectConfig,
      request: {
        runId: compile.runId,
        taskId,
        executionId: `${compile.runId}-${taskId.toLowerCase()}-attempt-1`,
        sessionId: `${compile.runId}-${taskId.toLowerCase()}-session`,
        worktreePath: worktree.worktree.path,
        prompt: claudePrompt({
          manifest,
          task,
          taskId,
          snapshot,
          context: options.taskContexts?.[taskId],
          contextPackage: options.taskContextPackages?.[taskId]
        }),
        startedAt: timestamp
      },
      claudeOverrides: options.adapterConfig,
      providerProcessRunner: (candidate) => executionEnvironment.providerProcessRunner?.(executionProfile, candidate.engine) ?? null
    });
    const execution = taskExecution.execution;
    const activeEngine = taskExecution.candidate.engine;
    const activeVersion = activeEngine === "claude" ? doctor.version : null;
    const taskUsageSamples = usageSamplesFromAttempts(taskExecution.attempts, taskId, "claude");
    // Recorded as soon as the engine returns, regardless of what this task does next
    // (mismatch/failure/gate-block below all return BLOCKED before this task's usage
    // was previously folded in) - a task that consumed real, billable tokens before
    // failing must not have that consumption silently discarded from the run's total.
    recordUsageSamples(taskUsageSamples);

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
    writeJson(join(taskRoot, "usage-samples.json"), taskUsageSamples);

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
        message: `Claude result identity does not match task ${taskId}.`,
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
        message: execution.result.failures[0]?.message ?? `Claude did not complete task ${taskId}.`,
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
    writeJson(
      join(taskRoot, "evidence.json"),
      evidenceFor(
        compile.runId,
        activeEngine,
        activeVersion,
        usageFromSamples(taskUsageSamples),
        taskGateReport.results,
        task,
        taskUsageSamples,
        environmentReport
      )
    );
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

    const budgetEvaluation = evaluateUsageBudget(usageTotals, budget);
    if (budgetEvaluation.status === "BLOCK") {
      const finding = budgetEvaluation.findings.find((candidate) => candidate.severity === "blocker")!;
      const runEvidencePath = join(compile.state.runRoot, "run-evidence.json");

      writeJson(runEvidencePath, aggregateEvidenceFor(compile.runId, "claude", doctor.version, usageTotals, gateResults, environmentReport));
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
        engine: "claude",
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
  const lastTaskRoot = lastTaskId ? taskWorktreePath({ stateRoot: stateRootFromRunRoot(compile.state.runRoot), runId: compile.runId, taskId: lastTaskId, attempt: 1 }) : compile.repository.ok ? compile.repository.worktreeRoot : options.repositoryPath;
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
  writeJson(runEvidencePath, aggregateEvidenceFor(compile.runId, "claude", doctor.version, usageTotals, gateResults, environmentReport));

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

    // A repair task has no dependsOn of its own (compileRepairTasks always
    // sets it to []), and runClaude never merges tasks onto a shared branch
    // the way fake-run.ts's parallel-writer integration does - each task
    // lands on its own isolated commit. Without this, a repair worktree
    // branching from manifest.base.commit would be missing every original
    // task's changes, including whatever file the finding is actually
    // about. Build that combined state once, here, only when repair is
    // about to be attempted (review already failed and independentReview
    // was supplied) - not on every run's happy path.
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
    engine: "claude",
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

export function claudeConfig(overrides: Partial<ClaudeCliAdapterConfig> = {}): ClaudeCliAdapterConfig {
  return {
    requiresCapabilitySmokeTest: true,
    ...overrides
  };
}

export function claudeAdapterConfigFromProject(config: ProjectConfig | null): Partial<ClaudeCliAdapterConfig> {
  const source = config?.adapters?.claude;

  return {
    ...(source?.executable !== undefined ? { executable: source.executable } : {}),
    ...(source?.model !== undefined ? { defaultModel: source.model } : {}),
    ...(source?.permissionMode !== undefined ? { permissionMode: source.permissionMode } : {}),
    ...(source?.allowedTools !== undefined ? { allowedTools: source.allowedTools } : {}),
    ...(source?.bareMode !== undefined ? { bareMode: source.bareMode } : {}),
    ...(source?.dangerouslySkipPermissions !== undefined ? { dangerouslySkipPermissions: source.dangerouslySkipPermissions } : {}),
    ...(source?.timeoutSeconds !== undefined ? { idleTimeoutMs: source.timeoutSeconds * 1000 } : {}),
    ...(source?.idleTimeoutSeconds !== undefined ? { idleTimeoutMs: source.idleTimeoutSeconds * 1000 } : {}),
    ...(source?.maximumRuntimeSeconds !== undefined ? { maximumRuntimeMs: source.maximumRuntimeSeconds * 1000 } : {}),
    ...(source?.maximumRepeatedProgressEvents !== undefined ? { maximumRepeatedProgressEvents: source.maximumRepeatedProgressEvents } : {}),
    ...(source?.maximumOutputBytes !== undefined ? { maximumOutputBytes: source.maximumOutputBytes } : {}),
    ...(source?.testedVersionRanges !== undefined ? { testedVersionRanges: source.testedVersionRanges } : {})
  };
}

function claudePrompt(input: {
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
        "You are executing inside ai-code-worker, not the interactive Claude Code session.",
        "Treat this JSON task envelope and its allowedPaths/forbiddenPaths as the active task scope.",
        "Do not broaden scope, push, deploy, or edit files outside allowedPaths.",
        "Never run git commit, git push, git reset, or git clean - the worker owns all commits.",
        "Complete the task in the worktree, then respond with your final message containing ONLY a " +
          "single JSON object and nothing else - no markdown fences, no prose before or after it - " +
          "matching exactly this shape: " +
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
  task: RunManifestTask,
  usageSamples: readonly UsageSample[] = [],
  environmentReport?: EnvironmentCapabilityReport
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
    ...(usageSamples.length > 0 ? { usageSamples } : {}),
    ...(environmentReport ? { executionEnvironment: environmentEvidence(environmentReport) } : {}),
    ...(taskTraceability ? { taskTraceability } : {})
  };
}

function aggregateEvidenceFor(
  runId: string,
  engine: RoutedEngine,
  engineVersion: string | null,
  totals: UsageTotals,
  commands: readonly QualityGateResult[] = [],
  environmentReport?: EnvironmentCapabilityReport
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
    artifacts: [],
    ...(environmentReport ? { executionEnvironment: environmentEvidence(environmentReport) } : {})
  };
}

function environmentEvidence(report: EnvironmentCapabilityReport): {
  readonly profileId: string;
  readonly profileSha256: string;
  readonly backend: string;
  readonly backendVersion: string;
  readonly securityBoundary: EnvironmentCapabilityReport["securityBoundary"];
} {
  return {
    profileId: report.profileId,
    profileSha256: report.profileSha256,
    backend: report.backend,
    backendVersion: report.backendVersion,
    securityBoundary: report.securityBoundary
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
  readonly recordUsageSamples: (samples: readonly UsageSample[]) => UsageTotals;
  readonly engineVersion: string | null;
  readonly environmentReport: EnvironmentCapabilityReport;
}):
  | { readonly status: "PASS"; readonly usageTotals: UsageTotals }
  | { readonly status: "BLOCKED"; readonly report: ClaudeRunReport } {
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

  const taskUsageSamples = readUsageSamplesFromEvidence(input.taskRoot, "claude", input.taskId);
  const recoveredUsageTotals = input.recordUsageSamples(taskUsageSamples);

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
    evidenceFor(
      input.compile.runId!,
      "claude",
      input.engineVersion,
      usageFromSamples(taskUsageSamples),
      taskGateReport.results,
      input.task,
      taskUsageSamples,
      input.environmentReport
    )
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
        usageTotals: recoveredUsageTotals,
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
    usageTotals: recoveredUsageTotals
  };
}

function recoveredTerminalRun(
  compile: CompileReport,
  taskOrder: readonly string[],
  recovery: RunCheckpoints,
  status: "DONE" | "BLOCKED",
  provider: "codex" | "claude"
): ClaudeRunReport {
  const usageAccumulator = new NormalizedUsageAccumulator();
  const taskCommits: Record<string, string> = {};
  const executedTasks: string[] = [];

  for (const taskId of taskOrder) {
    const commit = recovery.tasks[taskId]?.finishedCommit ?? recovery.tasks[taskId]?.committedCommit;
    if (commit) {
      taskCommits[taskId] = commit;
      executedTasks.push(taskId);
      usageAccumulator.addMany(readUsageSamplesFromEvidence(join(compile.state.runRoot!, "tasks", taskId), provider, taskId));
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
    usageTotals: usageAccumulator.report().totals,
    findings: []
  };
}

function blocked(compile: CompileReport, code: string, message: string): ClaudeRunReport {
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
}): ClaudeRunReport {
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
    engine: "claude",
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
  readonly finding: ClaudeRunFinding | null;
} {
  const results: QualityGateResult[] = [];
  const executionProfile = loadExecutionProfile(input.repositoryRoot);
  const executionEnvironment = resolveExecutionEnvironment(executionProfile);
  const environmentReport = executionEnvironment.doctor(executionProfile);
  if (!environmentReport.supported) {
    return {
      status: "BLOCKED",
      results,
      finding: {
        severity: "blocker",
        code: "ENVIRONMENT_UNAVAILABLE",
        message: "The configured execution environment is unavailable for quality gates."
      }
    };
  }
  const isolatedRunner = executionEnvironment.runWithProfileSync
    ? { profile: executionProfile, runWithProfileSync: executionEnvironment.runWithProfileSync.bind(executionEnvironment) }
    : undefined;

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

    const result = runQualityGateSync(resolved.command, isolatedRunner);
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

interface PersistedTaskEvidence {
  readonly input?: {
    readonly uncachedTokens?: number | null;
    readonly cacheReadTokens?: number | null;
    readonly cacheWriteTokens?: number | null;
  };
  readonly output?: {
    readonly standardTokens?: number | null;
  };
  readonly cost?: {
    readonly reportedCostUsd?: number | null;
  };
  readonly usageSamples?: readonly UsageSample[];
}

function readUsageSamplesFromEvidence(taskRoot: string, provider: "codex" | "claude" | "fake", taskId: string): UsageSample[] {
  try {
    const persistedSamples = JSON.parse(readFileSync(join(taskRoot, "usage-samples.json"), "utf8")) as unknown;
    if (Array.isArray(persistedSamples) && persistedSamples.length > 0) {
      return persistedSamples as UsageSample[];
    }
  } catch {
    // Older runs do not have the separate sample file; evidence.json is the fallback.
  }
  try {
    const evidence = JSON.parse(readFileSync(join(taskRoot, "evidence.json"), "utf8")) as PersistedTaskEvidence;
    if (Array.isArray(evidence.usageSamples) && evidence.usageSamples.length > 0) {
      return [...evidence.usageSamples];
    }
    return [legacyUsageSample(provider, `recovered:${taskId}`, `task:${taskId}`, usageFromPersistedEvidence(evidence))];
  } catch {
    return [legacyUsageSample(provider, `recovered:${taskId}`, `task:${taskId}`, unknownUsage())];
  }
}

function usageFromPersistedEvidence(evidence: PersistedTaskEvidence): EngineUsage {
  return {
    inputUncachedTokens: evidence.input?.uncachedTokens ?? null,
    cacheReadTokens: evidence.input?.cacheReadTokens ?? null,
    cacheWriteTokens: evidence.input?.cacheWriteTokens ?? null,
    outputTokens: evidence.output?.standardTokens ?? null,
    costUsd: evidence.cost?.reportedCostUsd ?? null
  };
}

function legacyUsageSample(provider: "codex" | "claude" | "fake", sampleId: string, seriesId: string, usage: EngineUsage): UsageSample {
  return { sampleId, seriesId, sequence: 1, provider, parserVersion: "evidence.v1", accountingMode: "incremental", usage };
}

function usageSamplesFromAttempts(attempts: readonly { readonly candidate: { readonly engine: "codex" | "claude" }; readonly execution: { readonly executionId: string; readonly events: readonly { readonly type: string }[]; readonly usage: EngineUsage } }[], taskId: string, provider: "codex" | "claude"): UsageSample[] {
  const samples = attempts
    .filter((attempt) => attempt.execution.events.some((event) => event.type === "execution.started"))
    .map((attempt, index) => ({
      sampleId: attempt.execution.executionId,
      seriesId: `task:${taskId}:attempt:${index + 1}`,
      sequence: 1,
      provider: attempt.candidate.engine,
      parserVersion: `${attempt.candidate.engine}.cli.v1`,
      accountingMode: "incremental" as const,
      usage: attempt.execution.usage
    }));
  return samples.length > 0 ? samples : [legacyUsageSample(provider, `execution:${taskId}`, `task:${taskId}:attempt:1`, unknownUsage())];
}

function usageFromSamples(samples: readonly UsageSample[]): EngineUsage {
  if (samples.length === 0) return unknownUsage();
  const report = new NormalizedUsageAccumulator().addMany(samples);
  return {
    inputUncachedTokens: report.totals.inputUncachedTokens,
    cacheReadTokens: report.totals.cacheReadTokens,
    cacheWriteTokens: report.totals.cacheWriteTokens,
    outputTokens: report.totals.outputTokens,
    costUsd: report.totals.costUsd
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
