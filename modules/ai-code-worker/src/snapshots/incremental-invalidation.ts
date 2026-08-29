import { buildTaskGraph, descendantsOf, type ManifestTask } from "../graph/task-graph.js";
import { canonicalJson } from "../manifest/normalize.js";
import type { JsonValue } from "../schema/json-schema.js";
import type { TaskInputSnapshot } from "./task-input-snapshot.js";
import type { SemanticTaskInputs } from "./semantic-task-inputs.js";

export type SemanticInvalidationReason =
  | "NEW_TASK"
  | "SNAPSHOT_UNREADABLE"
  | "DEPENDENCY_INPUT_CHANGED"
  | "CONTEXT_COMPILER_VERSION_CHANGED"
  | "CONTEXT_DIGEST_CHANGED"
  | "CONTRACT_HASHES_CHANGED"
  | "QUALITY_GATE_CONFIG_CHANGED"
  | "POLICY_CHANGED"
  | "TOOLCHAIN_CONFIG_CHANGED";

export interface TaskInvalidation {
  readonly taskId: string;
  readonly reasons: readonly SemanticInvalidationReason[];
  readonly propagation: "direct" | "descendant";
}

export interface IncrementalExecutionPlan {
  readonly reusableTaskIds: readonly string[];
  readonly directInvalidations: readonly TaskInvalidation[];
  readonly pendingDescendantTaskIds: readonly string[];
}

/**
 * Compares declared semantic inputs only. Checkout paths, timestamps, package IDs,
 * source discovery order, and run IDs deliberately cannot trigger re-execution.
 * Descendants are reported separately: they become stale only if a re-executed
 * dependency produces a different verified commit.
 */
export function planIncrementalExecution(input: {
  readonly tasks: readonly ManifestTask[];
  readonly previousSnapshots: ReadonlyMap<string, TaskInputSnapshot>;
  readonly currentSnapshots: ReadonlyMap<string, TaskInputSnapshot>;
}): IncrementalExecutionPlan {
  const graph = buildTaskGraph(input.tasks);
  const reusableTaskIds: string[] = [];
  const directInvalidations: TaskInvalidation[] = [];
  const pendingDescendants = new Set<string>();

  for (const taskId of graph.topologicalOrder) {
    const current = input.currentSnapshots.get(taskId);
    if (!current) continue;
    const reasons = invalidationReasons(input.previousSnapshots.get(taskId), current);
    if (reasons.length === 0) {
      reusableTaskIds.push(taskId);
      continue;
    }
    directInvalidations.push({ taskId, reasons, propagation: "direct" });
    for (const descendant of descendantsOf(graph, taskId)) pendingDescendants.add(descendant);
  }

  return {
    reusableTaskIds,
    directInvalidations,
    pendingDescendantTaskIds: graph.topologicalOrder.filter(
      (taskId) => pendingDescendants.has(taskId) && !directInvalidations.some((item) => item.taskId === taskId)
    )
  };
}

export function invalidationReasons(
  previous: TaskInputSnapshot | undefined,
  current: TaskInputSnapshot
): readonly SemanticInvalidationReason[] {
  if (!previous) return ["NEW_TASK"];
  const reasons: SemanticInvalidationReason[] = [];

  if (!same(previous.directDependencies, current.directDependencies) || !same(previous.transitiveDependencies, current.transitiveDependencies)) {
    reasons.push("DEPENDENCY_INPUT_CHANGED");
  }
  if (previous.contextCompilerVersion !== current.contextCompilerVersion) {
    reasons.push("CONTEXT_COMPILER_VERSION_CHANGED");
  }
  if (previous.contextDigest !== current.contextDigest) reasons.push("CONTEXT_DIGEST_CHANGED");
  if (!sameHashes(previous.contractHashes, current.contractHashes)) reasons.push("CONTRACT_HASHES_CHANGED");
  if (previous.qualityGateConfigHash !== current.qualityGateConfigHash) reasons.push("QUALITY_GATE_CONFIG_CHANGED");
  if (previous.policyHash !== current.policyHash) reasons.push("POLICY_CHANGED");
  if (previous.toolchainConfigHash !== current.toolchainConfigHash) reasons.push("TOOLCHAIN_CONFIG_CHANGED");

  return reasons;
}

export function semanticInputInvalidationReasons(
  previous: TaskInputSnapshot,
  current: SemanticTaskInputs
): readonly SemanticInvalidationReason[] {
  const projected = {
    ...previous,
    ...current
  } as TaskInputSnapshot;
  return invalidationReasons(previous, projected).filter((reason) => reason !== "DEPENDENCY_INPUT_CHANGED");
}

function same(left: unknown, right: unknown): boolean {
  return canonicalJson(left as JsonValue) === canonicalJson(right as JsonValue);
}

function sameHashes(left: TaskInputSnapshot["contractHashes"], right: TaskInputSnapshot["contractHashes"]): boolean {
  const normalize = (values: TaskInputSnapshot["contractHashes"]) =>
    [...values].sort((a, b) => a.canonicalRef.localeCompare(b.canonicalRef) || a.sha256.localeCompare(b.sha256));
  return same(normalize(left), normalize(right));
}
