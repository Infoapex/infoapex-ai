import { readyTasks, type TaskGraph, type TaskRuntimeState } from "../graph/task-graph.js";
import { partitionIntoWaves, type ConcurrencyScope } from "../policy/concurrency-policy.js";

export interface DispatchTaskScope {
  readonly id: string;
  readonly allowedPaths: readonly string[];
  readonly concurrencyKeys: readonly string[];
}

/**
 * Computes the next wave of tasks to dispatch: the subset of the current ready set
 * (per the existing readyTasks() dependency/state check) that can safely run as
 * concurrent writers together, capped at maximumParallelWriters.
 *
 * When maximumParallelWriters === 1, this always returns a single-task wave containing
 * readyTasks(...)[0] - the same task the pre-Phase-2 strictly-sequential
 * topologicalOrder loop would have processed next, so single-writer behavior is
 * unchanged byte-for-byte.
 */
export function nextDispatchWave(
  graph: TaskGraph,
  scopesById: ReadonlyMap<string, DispatchTaskScope>,
  states: ReadonlyMap<string, TaskRuntimeState>,
  maximumParallelWriters: number
): readonly string[] {
  const ready = readyTasks(graph, states);

  if (ready.length === 0) {
    return [];
  }

  const concurrencyScopes = new Map<string, ConcurrencyScope>(
    ready.map((taskId) => {
      const scope = scopesById.get(taskId);
      return [
        taskId,
        {
          taskId,
          allowedPaths: scope?.allowedPaths ?? [],
          concurrencyKeys: scope?.concurrencyKeys ?? []
        }
      ];
    })
  );

  const waves = partitionIntoWaves(ready, concurrencyScopes, maximumParallelWriters);
  return waves[0] ?? [];
}
