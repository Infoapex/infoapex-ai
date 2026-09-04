import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { sha256CanonicalJson } from "../canonical-json.js";
import { scheduleBounded, withTimeout, ExecutionTimeoutError } from "../execution/scheduler.js";
import { captureWorkspaceDiff, cleanupWorkspace, prepareWorkspace, preserveWorkspaceForEvaluation, type WorkspaceDiffCapture } from "../isolation/workspace.js";
import { appendEvent, atomicWriteJson, readEvents, readJson, type BenchmarkEventType } from "../persistence/store.js";
import { schemaRegistry } from "../schema-registry.js";
import { assertSeparateRoots, canonicalPath, containedPath } from "../security/paths.js";
import { assertObservationMatrix, createObservationMatrix, type ObservationMatrix, type ObservationPlan } from "./matrix.js";
import { captureObservationMetrics, type ObservationMetricCapture, type ObservationMetricInput } from "../metrics.js";

export type RuntimeFaultPoint = "after-preparation" | "after-execution-started" | "after-execution" | "after-evaluation-handoff" | "after-cleanup" | "after-terminal-snapshot" | "after-terminal-event";

export interface ExecutionOutcome {
  readonly status: "DONE" | "BLOCKED" | "FAILED";
  readonly message?: string;
  /** Optional BENCH-05 data supplied by an adapter/evaluator. It is persisted
   * separately from the closed observation contract and is never verdict logic. */
  readonly metrics?: ObservationMetricInput | ObservationMetricCapture;
}

export interface ObservationExecutionRequest {
  readonly observation: ObservationPlan;
  readonly workspacePath: string;
  readonly signal: AbortSignal;
}

export interface ObservationExecutor {
  execute(request: ObservationExecutionRequest): Promise<ExecutionOutcome>;
}

export interface RunExperimentOptions {
  readonly experiment: Record<string, unknown> | string;
  readonly repositoryPath: string;
  readonly stateRoot: string;
  readonly executor?: ObservationExecutor;
  readonly concurrency?: number;
  readonly timeoutMs?: number;
  /** Bounds provider work performed by this invocation. Existing terminal
   * observations are skipped and do not consume the allowance. */
  readonly maximumNewObservations?: number;
  readonly signal?: AbortSignal;
  readonly faultInjector?: (point: RuntimeFaultPoint, observation: ObservationPlan) => void | Promise<void>;
}

export interface ResumeExperimentOptions extends Omit<RunExperimentOptions, "experiment" | "repositoryPath"> {
  readonly experimentId: string;
  readonly repositoryPath?: string;
}

export interface RuntimeResult {
  readonly experimentId: string;
  readonly experimentHash: string;
  readonly status: "READY_FOR_EVALUATION" | "INTERRUPTED";
  readonly total: number;
  readonly terminal: number;
  readonly skipped: number;
  readonly observations: readonly Record<string, unknown>[];
}

interface RuntimeMetadata {
  readonly schemaVersion: "1.0";
  readonly experimentId: string;
  readonly experimentHash: string;
  readonly repositoryPath: string;
}

export class DeterministicFakeExecutor implements ObservationExecutor {
  public async execute(request: ObservationExecutionRequest): Promise<ExecutionOutcome> {
    if (request.signal.aborted) throw request.signal.reason ?? new Error("Observation cancelled.");
    const marker = join(request.workspacePath, ".benchmark-fake-result.json");
    if (existsSync(marker)) throw new Error("Workspace was contaminated by another observation.");
    writeFileSync(marker, `${JSON.stringify({ observationId: request.observation.id, armId: request.observation.armId, seed: request.observation.seed })}\n`, "utf8");
    return { status: "DONE" };
  }
}

export async function runExperiment(options: RunExperimentOptions): Promise<RuntimeResult> {
  const experiment = loadExperiment(options.experiment);
  const repository = canonicalPath(options.repositoryPath);
  const stateCandidate = canonicalPath(options.stateRoot);
  assertSeparateRoots(repository, stateCandidate);
  const stateRoot = canonicalPath(stateCandidate, true);
  const experimentId = requiredId(experiment.id);
  const experimentHash = experiment.experimentHash as string;
  const paths = createPaths(stateRoot, experimentId);
  mkdirSync(paths.root, { recursive: true });
  for (const directory of [paths.observations, paths.steps, paths.evidence, paths.evaluationWorkspaces, paths.workspaces, paths.records]) mkdirSync(directory, { recursive: true });
  atomicWriteJson(paths.experiment, experiment);
  const metadata: RuntimeMetadata = { schemaVersion: "1.0", experimentId, experimentHash, repositoryPath: repository };
  atomicWriteJson(paths.metadata, metadata);
  let matrix: ObservationMatrix;
  if (existsSync(paths.matrix)) {
    matrix = readJson<ObservationMatrix>(paths.matrix);
    assertObservationMatrix(matrix, experimentHash);
    const expected = createObservationMatrix(experiment);
    if (sha256CanonicalJson(matrix) !== sha256CanonicalJson(expected)) throw new Error("Frozen observation matrix differs from the experiment-derived matrix.");
  } else {
    matrix = createObservationMatrix(experiment);
    atomicWriteJson(paths.matrix, matrix);
  }
  event(paths.events, experimentHash, "experiment.frozen", "experiment", { experimentId });
  event(paths.events, experimentHash, "experiment.started", "experiment", { experimentId });
  const before = countTerminal(paths, matrix);
  const executor = options.executor ?? new DeterministicFakeExecutor();
  const maximumNewObservations = optionalPositiveInteger(options.maximumNewObservations, "maximumNewObservations");
  const pending = matrix.observations.filter((observation) => !existsSync(observationPath(paths.observations, observation)));
  const scheduled = maximumNewObservations === undefined ? pending : pending.slice(0, maximumNewObservations);
  await scheduleBounded(scheduled, (observation) => processObservation(paths, experimentHash, repository, observation, executor, options), { concurrency: options.concurrency ?? 1, signal: options.signal });
  return finish(paths, experimentId, experimentHash, matrix, before);
}

export async function resumeExperiment(options: ResumeExperimentOptions): Promise<RuntimeResult> {
  const stateRoot = canonicalPath(options.stateRoot);
  const root = containedPath(containedPath(stateRoot, "benchmarks"), requiredId(options.experimentId));
  const metadata = readJson<RuntimeMetadata>(containedPath(root, "runtime.json"));
  if (metadata.schemaVersion !== "1.0" || metadata.experimentId !== options.experimentId) throw new Error("Invalid runtime metadata.");
  if (options.repositoryPath && canonicalPath(options.repositoryPath) !== metadata.repositoryPath) throw new Error("Resume repository differs from the recorded canonical repository.");
  return runExperiment({ ...options, experiment: containedPath(root, "experiment.json"), repositoryPath: metadata.repositoryPath });
}

function loadExperiment(input: Record<string, unknown> | string): Record<string, unknown> {
  const value = typeof input === "string" ? JSON.parse(readFileSync(resolve(input), "utf8")) as Record<string, unknown> : input;
  schemaRegistry.assertValid("benchmark-experiment.schema.json", value);
  if (value.status !== "FROZEN") throw new Error("Only a FROZEN experiment can enter the BENCH-04 runtime.");
  const claimed = value.experimentHash;
  const snapshot = Object.fromEntries(Object.entries(value).filter(([key]) => key !== "experimentHash"));
  if (claimed !== sha256CanonicalJson(snapshot)) throw new Error("Experiment hash does not match its canonical snapshot.");
  return value;
}

function createPaths(stateRoot: string, experimentId: string) {
  const benchmarks = join(stateRoot, "benchmarks"); mkdirSync(benchmarks, { recursive: true });
  const root = containedPath(benchmarks, experimentId);
  const evidence = join(root, "evidence");
  return { root, experiment: join(root, "experiment.json"), metadata: join(root, "runtime.json"), matrix: join(root, "matrix.json"), events: join(root, "events.jsonl"), observations: join(root, "observations"), steps: join(root, "steps"), evidence, evaluationWorkspaces: join(evidence, "workspaces"), workspaces: join(root, "workspaces"), records: join(root, "workspace-records") };
}

async function processObservation(paths: ReturnType<typeof createPaths>, experimentHash: string, repository: string, observation: ObservationPlan, executor: ObservationExecutor, options: RunExperimentOptions): Promise<Record<string, unknown>> {
  const terminalPath = observationPath(paths.observations, observation);
  if (existsSync(terminalPath)) {
    const terminal = readJson<Record<string, unknown>>(terminalPath); schemaRegistry.assertValid("benchmark-observation.schema.json", terminal);
    return terminal;
  }
  event(paths.events, experimentHash, "observation.started", observation.id, payload(observation));
  const stepRoot = containedPath(paths.steps, observation.id); mkdirSync(stepRoot, { recursive: true });
  const preparedPath = join(stepRoot, "prepared.json");
  const executionStartedPath = join(stepRoot, "execution-started.json");
  const executionPath = join(stepRoot, "execution.json");
  const handoffPath = join(stepRoot, "evaluation-handoff.json");
  const cleanupPath = join(stepRoot, "cleanup.json");
  const recordPath = containedPath(paths.records, `${observation.id}.json`);
  const workspacePath = containedPath(paths.workspaces, observation.id);
  if (!existsSync(preparedPath)) {
    prepareWorkspace(repository, paths.workspaces, paths.records, observation.id, experimentHash);
    atomicWriteJson(preparedPath, { schemaVersion: "1.0", observationId: observation.id, workspace: observation.id, strategy: "safe-copy" });
    event(paths.events, experimentHash, "observation.prepared", observation.id, payload(observation));
    await options.faultInjector?.("after-preparation", observation);
  } else if (!existsSync(executionPath) && !existsSync(workspacePath)) {
    prepareWorkspace(repository, paths.workspaces, paths.records, observation.id, experimentHash);
  }
  let execution: { status: "DONE" | "BLOCKED" | "FAILED" | "TIMEOUT"; message: string | null; startedAt: string; finishedAt: string; metrics: ObservationMetricCapture | null; capturedDiff: WorkspaceDiffCapture };
  if (existsSync(executionPath)) execution = readJson<typeof execution>(executionPath);
  else {
    if (existsSync(executionStartedPath)) {
      // An interrupted execution has no trustworthy result. Discard its private copy
      // and retry from the pristine source; no changes can leak into the retry.
      prepareWorkspace(repository, paths.workspaces, paths.records, observation.id, experimentHash);
    } else {
      atomicWriteJson(executionStartedPath, { schemaVersion: "1.0", observationId: observation.id, started: true });
    }
    await options.faultInjector?.("after-execution-started", observation);
    const startedAt = new Date().toISOString();
    try {
      const outcome = await withTimeout((signal) => executor.execute({ observation, workspacePath, signal }), options.timeoutMs ?? 30_000, options.signal);
      const finishedAt = new Date().toISOString();
      const rawMetrics = outcome.metrics;
      const metrics = rawMetrics && "latency" in rawMetrics
        ? rawMetrics
        : rawMetrics
          ? captureObservationMetrics({ ...rawMetrics, elapsedMs: rawMetrics.elapsedMs ?? Date.parse(finishedAt) - Date.parse(startedAt) })
          : null;
      execution = { status: outcome.status, message: outcome.message ?? null, startedAt, finishedAt, metrics, capturedDiff: captureWorkspaceDiff(repository, workspacePath) };
    } catch (error) {
      execution = { status: error instanceof ExecutionTimeoutError ? "TIMEOUT" : "FAILED", message: error instanceof Error ? error.message : String(error), startedAt, finishedAt: new Date().toISOString(), metrics: null, capturedDiff: captureWorkspaceDiff(repository, workspacePath) };
    }
    atomicWriteJson(executionPath, execution);
    event(paths.events, experimentHash, "observation.executed", observation.id, { ...payload(observation), status: execution.status });
    await options.faultInjector?.("after-execution", observation);
  }
  const evaluationWorkspacePath = containedPath(paths.evaluationWorkspaces, observation.id);
  preserveWorkspaceForEvaluation(workspacePath, evaluationWorkspacePath);
  if (!existsSync(handoffPath)) {
    const handoff = { schemaVersion: "1.0", observationId: observation.id, experimentHash, executionStatus: execution.status, executionSha256: sha256CanonicalJson(execution), evaluatorStatus: "PENDING", evaluatorWorkspace: `workspaces/${observation.id}` };
    atomicWriteJson(containedPath(paths.evidence, `${observation.id}.json`), handoff);
    atomicWriteJson(handoffPath, handoff);
    event(paths.events, experimentHash, "observation.evaluation-ready", observation.id, { ...payload(observation), evaluatorStatus: "PENDING" });
    await options.faultInjector?.("after-evaluation-handoff", observation);
  }
  if (execution.metrics) atomicWriteJson(containedPath(paths.evidence, `${observation.id}.metrics.json`), execution.metrics);
  if (!existsSync(cleanupPath)) {
    cleanupWorkspace(paths.workspaces, recordPath, observation.id, experimentHash);
    await options.faultInjector?.("after-cleanup", observation);
    atomicWriteJson(cleanupPath, { schemaVersion: "1.0", observationId: observation.id, cleaned: true });
    event(paths.events, experimentHash, "observation.cleanup-completed", observation.id, payload(observation));
  }
  const status = execution.status;
  const terminal = {
    schemaVersion: "1.0", id: observation.id, experimentHash, taskId: observation.taskId, armId: observation.armId, repetition: observation.repetition,
    status, startedAt: execution.startedAt, finishedAt: execution.finishedAt,
    telemetry: {
      providerLatencyMs: execution.metrics?.latency.providerLatencyMs ?? null,
      harnessLatencyMs: execution.metrics?.latency.harnessLatencyMs ?? null,
      inputTokens: execution.metrics?.usage.inputUncachedTokens ?? null,
      outputTokens: execution.metrics?.usage.outputTokens ?? null,
      costUsd: execution.metrics?.usage.costUsd ?? null
    },
    failure: status === "DONE" ? null : { kind: status === "TIMEOUT" ? "timeout" : "implementation", message: execution.message ?? `Observation ${status.toLowerCase()}.` }
  };
  schemaRegistry.assertValid("benchmark-observation.schema.json", terminal);
  atomicWriteJson(terminalPath, terminal);
  await options.faultInjector?.("after-terminal-snapshot", observation);
  await options.faultInjector?.("after-terminal-event", observation);
  return terminal;
}

function finish(paths: ReturnType<typeof createPaths>, experimentId: string, experimentHash: string, matrix: ObservationMatrix, before: number): RuntimeResult {
  const observations = matrix.observations.flatMap((item) => { const path = observationPath(paths.observations, item); return existsSync(path) ? [readJson<Record<string, unknown>>(path)] : []; });
  // Execution terminal snapshots are only ready for BENCH-06. Protocol-level
  // completion is written by evaluateExperiment after gates, scope, and hidden
  // oracles all have terminal evidence.
  const status = observations.length === matrix.observations.length ? "READY_FOR_EVALUATION" : "INTERRUPTED";
  readEvents(paths.events); // final full validation
  return { experimentId, experimentHash, status, total: matrix.observations.length, terminal: observations.length, skipped: before, observations };
}

function observationPath(root: string, observation: ObservationPlan): string {
  const task = containedPath(root, observation.taskId); mkdirSync(task, { recursive: true });
  const arm = containedPath(task, observation.armId); mkdirSync(arm, { recursive: true });
  return containedPath(arm, `${observation.repetition}.json`);
}

function countTerminal(paths: ReturnType<typeof createPaths>, matrix: ObservationMatrix): number {
  return matrix.observations.filter((item) => existsSync(observationPath(paths.observations, item))).length;
}

function payload(observation: ObservationPlan): Record<string, string | number> { return { observationId: observation.id, taskId: observation.taskId, armId: observation.armId, repetition: observation.repetition, seed: observation.seed }; }

function event(path: string, experimentHash: string, type: BenchmarkEventType, discriminator: string, value: Record<string, string | number | boolean | null>): void {
  const hash = createHash("sha256").update(`${experimentHash}/${type}/${discriminator}`).digest("hex");
  appendEvent(path, { schemaVersion: "1.0", id: `evt-${hash.slice(0, 40)}`, experimentHash, type, payload: value });
}

function requiredId(value: unknown): string {
  if (typeof value !== "string" || !/^[a-z][a-z0-9-]{2,63}$/u.test(value)) throw new Error("Invalid experiment ID.");
  return value;
}

function optionalPositiveInteger(value: number | undefined, name: string): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be a positive safe integer.`);
  return value;
}

export { createObservationMatrix, assertObservationMatrix } from "./matrix.js";
export { readEvents } from "../persistence/store.js";
