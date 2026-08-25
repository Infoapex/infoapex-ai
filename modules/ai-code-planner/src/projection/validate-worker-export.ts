import type { WorkerManifestTask } from '../types.js';

const KINDS = new Set(['contract', 'backend', 'frontend', 'database', 'docs', 'test', 'review', 'repair', 'other']);
const RISKS = new Set(['low', 'medium', 'high']);
const WORKER_TASK_ID = /^[A-Z0-9][A-Z0-9._-]*$/;

export function validateWorkerTaskExport(tasks: readonly WorkerManifestTask[]): string[] {
  const errors: string[] = [];
  if (tasks.length === 0) errors.push('tasks must contain at least one task');
  const ids = new Set<string>();
  for (const task of tasks) {
    if (ids.has(task.id)) errors.push(`duplicate task id: ${task.id}`);
    ids.add(task.id);
    if (!WORKER_TASK_ID.test(task.id)) {
      errors.push(`${task.id}: task id must match ${WORKER_TASK_ID.source}`);
    }
    if (!KINDS.has(task.kind)) errors.push(`${task.id}: invalid worker kind '${task.kind}'`);
    if (!task.role.trim()) errors.push(`${task.id}: role must be non-empty`);
    if (task.acceptanceCriteria.length === 0) errors.push(`${task.id}: acceptanceCriteria must not be empty`);
    if (!RISKS.has(task.risk)) errors.push(`${task.id}: invalid risk '${task.risk}'`);
    for (const dependency of task.dependsOn) {
      if (dependency === task.id) errors.push(`${task.id}: task cannot depend on itself`);
    }
  }
  return errors;
}
