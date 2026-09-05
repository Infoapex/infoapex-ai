import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  resolveUsageCheckpointLogPath,
  UsageCheckpointLog,
  type UsageCheckpointTaskKind,
  type UsageCheckpointTaskRisk
} from "../benchmark/usage-checkpoint.js";
import { runCompile, type CompileReport } from "../compile/compile.js";
import { FakeEngineAdapter } from "../engines/fake-engine.js";
import type { EngineUsage } from "../engines/engine-event.js";
import { currentHead, git } from "../git/diff.js";
import { createWorkerCommit } from "../git/commit.js";
import { createTaskWorktree, taskWorktreePath } from "../git/worktree.js";
import { buildTaskGraph, getTask, type ManifestTask, type TaskRuntimeState } from "../graph/task-graph.js";
import { EventLog } from "../persistence/event-log.js";
import { recoverRunCheckpoints, type RunCheckpoints } from "../persistence/recovery.js";
import { createRunTelemetry } from "../telemetry/run-telemetry.js";
import { normalizePolicyPath } from "../policy/scope-policy.js";
import {
  addUsage,
  budgetFromManifest,
  emptyUsageTotals,
  evaluateUsageBudget,
  type UsageTotals
} from "../policy/usage-budget.js";
import { writeRunReports } from "../report/run-report.js";
import { writeBlockedReport, writeRepairEvidenceReport } from "../report/export-artifacts.js";
import { SchemaRegistry } from "../schema/json-schema.js";
import { resolveQualityGate } from "../runner/quality-gate-config.js";
import { runQualityGateSync, toEvidenceCommand, type QualityGateResult } from "../runner/quality-gate.js";
import { buildCoverageReview } from "../review/coverage-review.js";
import { buildTaskInputSnapshot, type SnapshotManifest } from "../snapshots/task-input-snapshot.js";
import type { SemanticTaskInputs } from "../snapshots/semantic-task-inputs.js";
import { cherryPickSequence } from "../git/cherry-pick.js";
import { enforceSyncRootForParallelDispatch } from "../git/sync-root.js";
import { nextDispatchWave, type DispatchTaskScope } from "./dag-scheduler.js";
import { integrateTaskCommits } from "./integration.js";
import { runIndependentReviewAndRepair, type IndependentReviewer } from "./independent-review-repair.js";
import type { RepairCycleExecutor } from "../repair/repair-cycle.js";
import { buildTaskEvidenceTraceability } from "../evidence/task-traceability.js";
import type { ManifestTaskTraceability } from "../manifest/traceability.js";
import { buildSemanticSourceMap, writeSemanticSourceMap } from "../source-map/semantic-source-map.js";

export interface FakeRunOptions {
  readonly repositoryPath: string;
  readonly planPath: string;
  readonly runId?: string;
  readonly now?: string;
  readonly semanticTaskInputs?: Readonly<Record<string, SemanticTaskInputs>>;
  /** Optional hook: when the structural coverage review fails, run an
   *  independent review and, if it has blocking findings, attempt bounded
   *  repair before giving up (IMPLEMENTATION-PLAN.md §11.6 steps 7-9).
   *  Omitted by default - existing behavior (block immediately on review
   *  failure) is unchanged when no provider is given. */
  readonly independentReview?: IndependentReviewIntegration;
}

export interface IndependentReviewIntegration {
  readonly reviewer: IndependentReviewer;
  readonly executeRepairCycle: RepairCycleExecutor;
  readonly maximumAttemptsPerTask?: number;
}

export interface FakeRunReport {
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
  readonly findings: readonly FakeRunFinding[];
}

export interface FakeRunFinding {
  readonly severity: "blocker";
  readonly code: string;
  readonly message: string;
}

export function runFake(options: FakeRunOptions): FakeRunReport {
  const registry = SchemaRegistry.load();
  const compile = runCompile(options);

  if (compile.status === "BLOCKED" || !compile.runId || !compile.state.runRoot || !compile.state.manifestPath || !compile.state.eventLogPath) {
    return blocked(compile, "COMPILE_BLOCKED", compile.findings[0]?.message ?? "Compile did not pass.");
  }

  const telemetry = createRunTelemetry({ runId: compile.runId, runRoot: compile.state.runRoot, registry });
  const eventLog = new EventLog(compile.state.eventLogPath, registry, telemetry);
  const currentEvents = eventLog.read().events;
  const manifest = JSON.parse(readFileSync(compile.state.manifestPath, "utf8")) as RunManifest;
  const graph = buildTaskGraph(manifest.tasks);
  const recovery = recoverRunCheckpoints(currentEvents);
  const states = new Map<string, TaskRuntimeState>();
  const executedTasks: string[] = [];
  const taskCommits: Record<string, string> = {};
  const evidenceByTask: Record<string, string> = {};
  const gateResults: QualityGateResult[] = [];
  const engine = new FakeEngineAdapter(registry);
  const checkpointLog = new UsageCheckpointLog(
    resolveUsageCheckpointLogPath(compile.repository.ok ? compile.repository.worktreeRoot : options.repositoryPath),
    registry
  );
  const budget = budgetFromManifest(manifest.budgets);
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

  const maximumParallelWriters = Number(manifest.budgets.maximumParallelWriters ?? 1);
  const dispatchScopesById = new Map<string, DispatchTaskScope>(
    manifest.tasks.map((manifestTask) => [
      manifestTask.id,
      { id: manifestTask.id, allowedPaths: manifestTask.allowedPaths, concurrencyKeys: manifestTask.concurrencyKeys ?? [] }
    ])
  );
  const remainingTaskIds = new Set(graph.topologicalOrder);

  while (remainingTaskIds.size > 0) {
    const wave = planDispatchWave({
      graph,
      scopesById: dispatchScopesById,
      states,
      maximumParallelWriters,
      gitCommonDir: compile.repository.ok ? compile.repository.gitCommonDir : null
    });

    if (wave.length === 0) {
      break;
    }

    eventLog.append({
      eventId: `${compile.runId}-${String(eventLog.read().events.length).padStart(4, "0")}-wave-dispatched`,
      runId: compile.runId,
      type: "run.wave-dispatched",
      createdAt: timestampAt(options.now ?? new Date().toISOString(), tick),
      payload: { taskIds: wave, maximumParallelWriters }
    });

  for (const taskId of wave) {
    remainingTaskIds.delete(taskId);
    const timestamp = timestampAt(options.now ?? new Date().toISOString(), tick);
    const taskRoot = join(compile.state.runRoot, "tasks", taskId);
    const task = getTask(graph, taskId) as RunManifestTask;
    const checkpoint = recovery.tasks[taskId];

    if (checkpoint?.finishedCommit) {
      states.set(taskId, { status: "PASSED", commit: checkpoint.finishedCommit });
      taskCommits[taskId] = checkpoint.finishedCommit;
      evidenceByTask[taskId] = `tasks/${taskId}/evidence.json`;
      executedTasks.push(taskId);
      usageTotals = addUsage(usageTotals, fakeUsage());
      tick += 1;
      continue;
    }

    const snapshot = buildTaskInputSnapshot({
      manifest,
      taskId,
      states,
      registry,
      semanticInputs: options.semanticTaskInputs?.[taskId]
    });
    const touchedFile = fakeTouchedFile(task);

    if (!touchedFile) {
      return blockRunningRun({
        compile,
        eventLog,
        code: "NO_MATERIALIZABLE_ALLOWED_PATH",
        message: `Task ${taskId} has no materializable allowed path for the fake writer.`,
        executedTasks,
        taskCommits,
        gateResults,
        usageTotals,
        now: timestamp
      });
    }

    checkpointLog.append({
      checkpointId: `${compile.runId}-${taskId}-start`,
      runId: compile.runId,
      taskId,
      scope: "task",
      engine: "fake",
      phase: "start",
      createdAt: timestamp,
      taskKind: task.kind,
      taskRisk: task.risk
    });

    const execution = engine.start({
      runId: compile.runId,
      taskId,
      executionId: `${compile.runId}-${taskId.toLowerCase()}-attempt-1`,
      sessionId: `${compile.runId}-${taskId.toLowerCase()}-session`,
      startedAt: timestamp,
      touchedFiles: [touchedFile],
      usage: fakeUsage()
    });

    checkpointLog.append({
      checkpointId: `${compile.runId}-${taskId}-end`,
      runId: compile.runId,
      taskId,
      scope: "task",
      engine: "fake",
      phase: "end",
      createdAt: timestamp,
      taskKind: task.kind,
      taskRisk: task.risk,
      tokens: execution.usage
    });

    if (checkpoint?.committedCommit && checkpoint.worktreePath) {
      const recovered = continueFromCommittedTask({
        compile,
        eventLog,
        task,
        taskRoot,
        worktreePath: checkpoint.worktreePath,
        expectedCommit: checkpoint.committedCommit,
        execution,
        timestamp,
        taskId,
        states,
        executedTasks,
        taskCommits,
        evidenceByTask,
        gateResults,
        usageTotals
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

    const dependencyCherryPick = cherryPickSequence(
      worktree.worktree.path,
      snapshot.transitiveDependencies.map((dependency) => dependency.commit)
    );

    if (dependencyCherryPick.status === "CONFLICT") {
      return blockRunningRun({
        compile,
        eventLog,
        code: "DEPENDENCY_CHERRY_PICK_CONFLICT",
        message: `Task ${taskId} could not materialize dependency ${dependencyCherryPick.commit}: conflicts in ${dependencyCherryPick.conflictedPaths.join(", ") || "unknown paths"}.`,
        executedTasks,
        taskCommits,
        gateResults,
        usageTotals,
        now: timestamp
      });
    }

    const expectedHead = currentHead(worktree.worktree.path);
    writeFakeTaskOutput(worktree.worktree.path, touchedFile, compile.runId, taskId, snapshot.inputTree);
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

    mkdirSync(taskRoot, { recursive: true });
    writeJson(join(taskRoot, "task-input.json"), snapshot);
    writeJson(join(taskRoot, "engine-events.json"), execution.events);
    writeJson(join(taskRoot, "agent-result.json"), execution.result);
    writeJson(join(taskRoot, "commit.json"), commit.commit);

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
    writeJson(join(taskRoot, "evidence.json"), evidenceFor(compile.runId, execution, taskGateReport.results, task));
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
      const blockedAt = timestampAt(options.now ?? new Date().toISOString(), tick);
      const runEvidencePath = join(compile.state.runRoot, "run-evidence.json");

      writeJson(runEvidencePath, aggregateEvidenceFor(compile.runId, usageTotals, gateResults));
      eventLog.append({
        eventId: `${compile.runId}-${String(eventLog.read().events.length).padStart(4, "0")}-run-blocked`,
        runId: compile.runId,
        type: "run.blocked",
        createdAt: blockedAt,
        payload: { code: finding.code, reason: finding.message, field: finding.field }
      });
      writeRunReports({
        compile,
        status: "BLOCKED",
        engine: "fake",
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
  }

  if (maximumParallelWriters > 1 && executedTasks.length > 1) {
    const integrationWorktree = createTaskWorktree({
      repositoryPath: compile.repository.ok ? compile.repository.worktreeRoot : options.repositoryPath,
      stateRoot: stateRootFromRunRoot(compile.state.runRoot),
      runId: compile.runId,
      taskId: "__integration__",
      attempt: 1,
      baseCommit: manifest.base.commit,
      recreateIfExists: true
    });

    if (integrationWorktree.status === "BLOCKED" || !integrationWorktree.worktree) {
      return blockRunningRun({
        compile,
        eventLog,
        code: integrationWorktree.findings[0]?.code ?? "INTEGRATION_WORKTREE_FAILED",
        message: integrationWorktree.findings[0]?.message ?? "Could not create the integration worktree.",
        executedTasks,
        taskCommits,
        gateResults,
        usageTotals,
        now: timestampAt(options.now ?? new Date().toISOString(), tick)
      });
    }

    const integration = integrateTaskCommits({
      worktreePath: integrationWorktree.worktree.path,
      baseCommit: manifest.base.commit,
      orderedTaskIds: graph.topologicalOrder,
      taskCommits: new Map(Object.entries(taskCommits))
    });

    if (integration.status === "BLOCKED" && integration.conflictReport) {
      const conflictReportPath = join(compile.state.runRoot, "conflict-report.json");
      writeJson(conflictReportPath, integration.conflictReport);

      return blockRunningRun({
        compile,
        eventLog,
        code: "INTEGRATION_CONFLICT",
        message: `Integration conflict on task ${integration.conflictReport.taskId} commit ${integration.conflictReport.commit}: ${integration.conflictReport.conflictedPaths.join(", ") || "unknown paths"}. See conflict-report.json.`,
        executedTasks,
        taskCommits,
        gateResults,
        usageTotals,
        now: timestampAt(options.now ?? new Date().toISOString(), tick)
      });
    }

    writeJson(join(compile.state.runRoot, "integration-report.json"), {
      status: integration.status,
      integratedTaskIds: integration.integratedTaskIds
    });
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
  writeJson(runEvidencePath, aggregateEvidenceFor(compile.runId, usageTotals, gateResults));

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

    const repairOutcome = runIndependentReviewAndRepair({
      runId: compile.runId,
      graphVersion: manifest.graphVersion,
      taskCommits,
      maximumRepairCycles: Number(manifest.budgets.maximumRepairCycles ?? 0),
      maximumAttemptsPerTask: options.independentReview.maximumAttemptsPerTask ?? 1,
      reviewer: options.independentReview.reviewer,
      executeRepairCycle: options.independentReview.executeRepairCycle,
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
    engine: "fake",
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
  readonly acceptanceCriteria: readonly string[];
  readonly verify: readonly string[];
  readonly concurrencyKeys: readonly string[];
  readonly traceability?: ManifestTaskTraceability;
}

function evidenceFor(
  runId: string,
  execution: ReturnType<FakeEngineAdapter["start"]>,
  commands: readonly QualityGateResult[],
  task: RunManifestTask
): unknown {
  const inputTotal =
    execution.usage.inputUncachedTokens === null &&
    execution.usage.cacheReadTokens === null &&
    execution.usage.cacheWriteTokens === null
      ? null
      : (execution.usage.inputUncachedTokens ?? 0) +
        (execution.usage.cacheReadTokens ?? 0) +
        (execution.usage.cacheWriteTokens ?? 0);

  const taskTraceability = buildTaskEvidenceTraceability(task, commands);
  return {
    schemaVersion: taskTraceability ? "1.1" : "1.0",
    runId,
    engine: {
      name: "fake",
      version: "0.0.0",
      adapterVersion: "0.0.0"
    },
    input: {
      uncachedTokens: execution.usage.inputUncachedTokens,
      cacheReadTokens: execution.usage.cacheReadTokens,
      cacheWriteTokens: execution.usage.cacheWriteTokens,
      totalReportedTokens: inputTotal
    },
    output: {
      standardTokens: execution.usage.outputTokens,
      reasoningTokens: null,
      totalReportedTokens: execution.usage.outputTokens
    },
    cost: {
      reportedCostUsd: execution.usage.costUsd,
      estimatedCostUsd: null,
      currency: null
    },
    commands: commands.map(toEvidenceCommand),
    artifacts: [],
    ...(taskTraceability ? { taskTraceability } : {})
  };
}

function aggregateEvidenceFor(runId: string, totals: UsageTotals, commands: readonly QualityGateResult[] = []): unknown {
  const inputTotal =
    totals.inputUncachedTokens === null && totals.cacheReadTokens === null && totals.cacheWriteTokens === null
      ? null
      : (totals.inputUncachedTokens ?? 0) + (totals.cacheReadTokens ?? 0) + (totals.cacheWriteTokens ?? 0);

  return {
    schemaVersion: "1.0",
    runId,
    engine: {
      name: "fake",
      version: "0.0.0",
      adapterVersion: "0.0.0"
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

function fakeTouchedFile(task: RunManifestTask): string | null {
  for (const pattern of task.allowedPaths) {
    const normalized = normalizePolicyPath(pattern);

    if (!normalized || normalized.includes("*") && !normalized.endsWith("/**")) {
      continue;
    }

    if (normalized.endsWith("/**")) {
      const prefix = normalized.slice(0, -3);
      return `${prefix}/ai-code-worker-${task.id.toLowerCase()}.txt`;
    }

    if (normalized.endsWith("/")) {
      return `${normalized}ai-code-worker-${task.id.toLowerCase()}.txt`;
    }

    return normalized;
  }

  return null;
}

function fakeUsage(): EngineUsage {
  return {
    inputUncachedTokens: 10,
    cacheReadTokens: 0,
    cacheWriteTokens: 1,
    outputTokens: 5,
    costUsd: null
  };
}

function continueFromCommittedTask(input: {
  readonly compile: CompileReport;
  readonly eventLog: EventLog;
  readonly task: RunManifestTask;
  readonly taskRoot: string;
  readonly worktreePath: string;
  readonly expectedCommit: string;
  readonly execution: ReturnType<FakeEngineAdapter["start"]>;
  readonly timestamp: string;
  readonly taskId: string;
  readonly states: Map<string, TaskRuntimeState>;
  readonly executedTasks: string[];
  readonly taskCommits: Record<string, string>;
  readonly evidenceByTask: Record<string, string>;
  readonly gateResults: QualityGateResult[];
  readonly usageTotals: UsageTotals;
}):
  | { readonly status: "PASS"; readonly usageTotals: UsageTotals }
  | { readonly status: "BLOCKED"; readonly report: FakeRunReport } {
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
    input.taskRoot ? join(input.taskRoot, "evidence.json") : "evidence.json",
    evidenceFor(input.compile.runId!, input.execution, taskGateReport.results, input.task)
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
    payload: { taskId: input.taskId, status: input.execution.result.status, commit: input.expectedCommit }
  });

  input.states.set(input.taskId, { status: "PASSED", commit: input.expectedCommit });
  input.taskCommits[input.taskId] = input.expectedCommit;
  input.executedTasks.push(input.taskId);

  return {
    status: "PASS",
    usageTotals: addUsage(input.usageTotals, input.execution.usage)
  };
}

function recoveredTerminalRun(
  compile: CompileReport,
  taskOrder: readonly string[],
  recovery: RunCheckpoints,
  status: "DONE" | "BLOCKED"
): FakeRunReport {
  let usageTotals = emptyUsageTotals;
  const taskCommits: Record<string, string> = {};
  const executedTasks: string[] = [];

  for (const taskId of taskOrder) {
    const commit = recovery.tasks[taskId]?.finishedCommit ?? recovery.tasks[taskId]?.committedCommit;
    if (commit) {
      taskCommits[taskId] = commit;
      executedTasks.push(taskId);
      usageTotals = addUsage(usageTotals, fakeUsage());
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

function writeFakeTaskOutput(worktreePath: string, relativePath: string, runId: string, taskId: string, inputTree: string): void {
  const absolutePath = join(worktreePath, ...relativePath.split("/"));
  mkdirSync(dirname(absolutePath), { recursive: true });
  writeFileSync(absolutePath, `run=${runId}\ntask=${taskId}\ninputTree=${inputTree}\n`, "utf8");
}

function planDispatchWave(input: {
  readonly graph: import("../graph/task-graph.js").TaskGraph;
  readonly scopesById: ReadonlyMap<string, DispatchTaskScope>;
  readonly states: ReadonlyMap<string, TaskRuntimeState>;
  readonly maximumParallelWriters: number;
  readonly gitCommonDir: string | null;
}): readonly string[] {
  const wave = nextDispatchWave(input.graph, input.scopesById, input.states, input.maximumParallelWriters);

  if (wave.length <= 1 || !input.gitCommonDir) {
    return wave;
  }

  const syncRoot = enforceSyncRootForParallelDispatch(input.gitCommonDir, wave.length);

  if (syncRoot.verdict === "block") {
    return [wave[0]!];
  }

  return wave;
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

function blocked(compile: CompileReport, code: string, message: string): FakeRunReport {
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
}): FakeRunReport {
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
    engine: "fake",
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
  readonly finding: FakeRunFinding | null;
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
