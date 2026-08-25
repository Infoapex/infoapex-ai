export interface ManifestTask {
  readonly id: string;
  readonly dependsOn: readonly string[];
}

export interface TaskGraph {
  readonly tasks: ReadonlyMap<string, ManifestTask>;
  readonly topologicalOrder: readonly string[];
}

export type TaskRuntimeStatus = "PENDING" | "PASSED" | "STALE" | "RUNNING" | "FAILED" | "BLOCKED";

export interface TaskRuntimeState {
  readonly status: TaskRuntimeStatus;
  readonly commit?: string;
}

export class TaskGraphError extends Error {
  constructor(
    readonly code: "DUPLICATE_TASK" | "UNKNOWN_DEPENDENCY" | "CYCLE_DETECTED",
    message: string
  ) {
    super(message);
    this.name = "TaskGraphError";
  }
}

export function buildTaskGraph(tasks: readonly ManifestTask[]): TaskGraph {
  const taskMap = new Map<string, ManifestTask>();

  for (const task of tasks) {
    if (taskMap.has(task.id)) {
      throw new TaskGraphError("DUPLICATE_TASK", `Duplicate task id: ${task.id}`);
    }

    taskMap.set(task.id, task);
  }

  for (const task of taskMap.values()) {
    for (const dependency of task.dependsOn) {
      if (!taskMap.has(dependency)) {
        throw new TaskGraphError("UNKNOWN_DEPENDENCY", `Task ${task.id} depends on unknown task ${dependency}`);
      }
    }
  }

  return {
    tasks: taskMap,
    topologicalOrder: topologicalSort(taskMap)
  };
}

export function readyTasks(graph: TaskGraph, states: ReadonlyMap<string, TaskRuntimeState>): string[] {
  return graph.topologicalOrder.filter((taskId) => {
    const task = getTask(graph, taskId);
    const state = states.get(taskId);

    if (state && state.status !== "PENDING" && state.status !== "STALE") {
      return false;
    }

    return task.dependsOn.every((dependency) => states.get(dependency)?.status === "PASSED");
  });
}

export function dependencyClosure(graph: TaskGraph, taskId: string): string[] {
  const visited = new Set<string>();
  const task = getTask(graph, taskId);

  for (const dependency of task.dependsOn) {
    visitDependency(graph, dependency, visited);
  }

  return graph.topologicalOrder.filter((candidate) => visited.has(candidate));
}

export function descendantsOf(graph: TaskGraph, changedTaskId: string): string[] {
  return graph.topologicalOrder.filter((taskId) => dependencyClosure(graph, taskId).includes(changedTaskId));
}

export function getTask(graph: TaskGraph, taskId: string): ManifestTask {
  const task = graph.tasks.get(taskId);

  if (!task) {
    throw new TaskGraphError("UNKNOWN_DEPENDENCY", `Unknown task: ${taskId}`);
  }

  return task;
}

function topologicalSort(tasks: ReadonlyMap<string, ManifestTask>): string[] {
  const permanent = new Set<string>();
  const temporary = new Set<string>();
  const order: string[] = [];

  for (const taskId of [...tasks.keys()].sort()) {
    visit(taskId, tasks, permanent, temporary, order);
  }

  return order;
}

function visit(
  taskId: string,
  tasks: ReadonlyMap<string, ManifestTask>,
  permanent: Set<string>,
  temporary: Set<string>,
  order: string[]
): void {
  if (permanent.has(taskId)) {
    return;
  }

  if (temporary.has(taskId)) {
    throw new TaskGraphError("CYCLE_DETECTED", `Dependency cycle includes task ${taskId}`);
  }

  temporary.add(taskId);

  for (const dependency of [...getTask({ tasks, topologicalOrder: [] }, taskId).dependsOn].sort()) {
    visit(dependency, tasks, permanent, temporary, order);
  }

  temporary.delete(taskId);
  permanent.add(taskId);
  order.push(taskId);
}

function visitDependency(graph: TaskGraph, taskId: string, visited: Set<string>): void {
  if (visited.has(taskId)) {
    return;
  }

  visited.add(taskId);

  for (const dependency of getTask(graph, taskId).dependsOn) {
    visitDependency(graph, dependency, visited);
  }
}
