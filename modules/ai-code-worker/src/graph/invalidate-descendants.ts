import {
  buildTaskGraph,
  descendantsOf,
  type TaskRuntimeState
} from "./task-graph.js";
import {
  buildTaskInputSnapshot,
  TaskInputSnapshotError,
  type SnapshotManifest,
  type TaskInputSnapshot
} from "../snapshots/task-input-snapshot.js";
import { SchemaRegistry } from "../schema/json-schema.js";

export interface InvalidateDescendantsInput {
  readonly manifest: SnapshotManifest;
  readonly states: ReadonlyMap<string, TaskRuntimeState>;
  readonly changedTaskId: string;
  readonly newCommit: string;
  readonly registry?: SchemaRegistry;
}

export interface InvalidateDescendantsResult {
  readonly states: ReadonlyMap<string, TaskRuntimeState>;
  /** Transitive descendants of changedTaskId, in topological order, all now STALE. */
  readonly staleTaskIds: readonly string[];
  /** New snapshots for the descendants whose dependencies are all currently
   *  PASSED (immediately re-computable). Deeper descendants stay STALE
   *  without a snapshot until their own blocking dependency re-passes - this
   *  function only resolves the direct consequence of one commit change, not
   *  the whole graph in one pass; a STALE task that later re-passes triggers
   *  the same invalidation for its own descendants in turn. */
  readonly newSnapshots: readonly TaskInputSnapshot[];
}

/**
 * IMPLEMENTATION-PLAN.md §10.4: "if it changes a dependency's commit, only
 * the transitive descendants become STALE and receive a new snapshot."
 * Marks changedTaskId PASSED at its new commit, marks every transitive
 * descendant STALE (readyTasks() in task-graph.ts already treats STALE like
 * PENDING, so the scheduler will re-run them), and rebuilds a
 * TaskInputSnapshot for whichever descendants can be recomputed right away.
 */
export function invalidateDescendants(input: InvalidateDescendantsInput): InvalidateDescendantsResult {
  const graph = buildTaskGraph(input.manifest.tasks);
  const staleTaskIds = descendantsOf(graph, input.changedTaskId);
  const registry = input.registry ?? SchemaRegistry.load();

  const nextStates = new Map(input.states);
  nextStates.set(input.changedTaskId, { status: "PASSED", commit: input.newCommit });

  for (const taskId of staleTaskIds) {
    nextStates.set(taskId, { status: "STALE" });
  }

  const newSnapshots: TaskInputSnapshot[] = [];

  for (const taskId of staleTaskIds) {
    try {
      newSnapshots.push(
        buildTaskInputSnapshot({
          manifest: input.manifest,
          taskId,
          states: nextStates,
          registry
        })
      );
    } catch (error) {
      if (error instanceof TaskInputSnapshotError) {
        continue;
      }

      throw error;
    }
  }

  return { states: nextStates, staleTaskIds, newSnapshots };
}
