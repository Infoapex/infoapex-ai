import { canonicalJson, sha256 } from "../manifest/normalize.js";
import { SchemaRegistry, type JsonValue } from "../schema/json-schema.js";
import { buildTaskGraph, dependencyClosure, getTask, type ManifestTask, type TaskRuntimeState } from "../graph/task-graph.js";

export interface SnapshotManifest {
  readonly runId: string;
  readonly graphVersion: number;
  readonly base: {
    readonly commit: string;
  };
  readonly tasks: readonly ManifestTask[];
}

export interface TaskInputSnapshot {
  readonly schemaVersion: "1.0";
  readonly runId: string;
  readonly taskId: string;
  readonly graphVersion: number;
  readonly rootBaseCommit: string;
  readonly directDependencies: readonly SnapshotDependency[];
  readonly transitiveDependencies: readonly SnapshotDependency[];
  readonly inputCommit: string;
  readonly inputTree: string;
  readonly compositionAlgorithm: "topological-task-id-v1";
  readonly snapshotMetadataSha256: string;
}

export interface SnapshotDependency {
  readonly taskId: string;
  readonly commit: string;
}

export interface BuildTaskInputSnapshotInput {
  readonly manifest: SnapshotManifest;
  readonly taskId: string;
  readonly states: ReadonlyMap<string, TaskRuntimeState>;
  readonly registry?: SchemaRegistry;
}

export class TaskInputSnapshotError extends Error {
  constructor(
    readonly code: "DEPENDENCY_NOT_PASSED" | "DEPENDENCY_MISSING_COMMIT",
    message: string
  ) {
    super(message);
    this.name = "TaskInputSnapshotError";
  }
}

export function buildTaskInputSnapshot(input: BuildTaskInputSnapshotInput): TaskInputSnapshot {
  const graph = buildTaskGraph(input.manifest.tasks);
  const task = getTask(graph, input.taskId);
  const directDependencies = task.dependsOn.map((dependency) => dependencyFor(input.states, dependency));
  const transitiveDependencies = dependencyClosure(graph, input.taskId).map((dependency) =>
    dependencyFor(input.states, dependency)
  );
  const materialized = materializeInput(input.manifest.base.commit, transitiveDependencies);
  const snapshotWithoutDigest = {
    schemaVersion: "1.0" as const,
    runId: input.manifest.runId,
    taskId: input.taskId,
    graphVersion: input.manifest.graphVersion,
    rootBaseCommit: input.manifest.base.commit,
    directDependencies,
    transitiveDependencies,
    inputCommit: materialized.inputCommit,
    inputTree: materialized.inputTree,
    compositionAlgorithm: "topological-task-id-v1" as const
  };
  const snapshot: TaskInputSnapshot = {
    ...snapshotWithoutDigest,
    snapshotMetadataSha256: sha256(canonicalJson(toJsonValue(snapshotWithoutDigest)))
  };

  (input.registry ?? SchemaRegistry.load()).assertValid("task-input-snapshot.schema.json", snapshot);

  return snapshot;
}

function dependencyFor(states: ReadonlyMap<string, TaskRuntimeState>, taskId: string): SnapshotDependency {
  const state = states.get(taskId);

  if (state?.status !== "PASSED") {
    throw new TaskInputSnapshotError("DEPENDENCY_NOT_PASSED", `Dependency ${taskId} has not passed`);
  }

  if (!state.commit) {
    throw new TaskInputSnapshotError("DEPENDENCY_MISSING_COMMIT", `Dependency ${taskId} has no verified commit`);
  }

  return {
    taskId,
    commit: state.commit
  };
}

function materializeInput(rootBaseCommit: string, dependencies: readonly SnapshotDependency[]): {
  readonly inputCommit: string;
  readonly inputTree: string;
} {
  const content = canonicalJson(toJsonValue({
    rootBaseCommit,
    dependencies
  }));

  return {
    inputCommit: sha256(`commit:${content}`).slice(0, 40),
    inputTree: sha256(`tree:${content}`).slice(0, 40)
  };
}

function toJsonValue(value: unknown): JsonValue {
  return value as JsonValue;
}
