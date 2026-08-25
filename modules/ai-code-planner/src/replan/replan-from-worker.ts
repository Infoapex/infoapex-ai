import type { Plan } from '../types.js';

export interface ReplanOptions {
  readonly profile: string;
  readonly taskIds?: readonly string[];
}

export interface ReplanResult {
  readonly plan: Plan;
  readonly affectedTaskIds: readonly string[];
  readonly reason: string;
}

export function replanFromWorkerFeedback(plan: Plan, feedback: unknown, options: ReplanOptions): ReplanResult {
  const payload = asRecord(asRecord(feedback).payload);
  const status = typeof payload.status === 'string' ? payload.status : 'UNKNOWN';
  const explicit = new Set(options.taskIds ?? []);
  const executed = new Set(asStringArray(payload.executedTasks));
  const affected = explicit.size > 0
    ? plan.tasks.filter(task => explicit.has(task.id)).map(task => task.id)
    : status === 'DONE' ? [] : plan.tasks.filter(task => !executed.has(task.id)).map(task => task.id);
  const affectedSet = new Set(affected);
  const nextPlan: Plan = {
    ...plan,
    tasks: plan.tasks.map(task => affectedSet.has(task.id) ? { ...task, executionProfile: options.profile } : task),
    planningProvenance: {
      ...(plan.planningProvenance ?? {}),
      replan: {
        source: 'worker-feedback',
        workerStatus: status,
        affectedTaskIds: affected,
        replacementProfile: options.profile,
        reason: 'Worker did not complete the task; planner assigned the next logical profile for continuation.'
      }
    }
  };
  return {
    plan: nextPlan,
    affectedTaskIds: affected,
    reason: status === 'DONE' ? 'Worker completed the run; no continuation is required.' : `Continuation profile '${options.profile}' assigned to ${affected.length} task(s).`
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' ? value as Record<string, unknown> : {};
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}
