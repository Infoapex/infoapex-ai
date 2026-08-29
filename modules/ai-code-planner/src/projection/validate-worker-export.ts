import type { WorkerManifestTask, WorkerManifestTaskV1_1 } from '../types.js';

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

export function validateWorkerTaskExportV1_1(tasks: readonly WorkerManifestTaskV1_1[]): string[] {
  const errors = validateWorkerTaskExport(tasks);
  const globalCriterionIds = new Set<string>();
  const globalGateIds = new Set<string>();

  for (const task of tasks) {
    const criteria = task.traceability.acceptanceCriteria;
    const gates = task.traceability.gates;
    const taskCriterionIds = new Set(criteria.map((criterion) => criterion.criterionId));
    const coveredCriterionIds = new Set<string>();

    if (criteria.length !== task.acceptanceCriteria.length ||
        criteria.some((criterion, index) => criterion.text !== task.acceptanceCriteria[index])) {
      errors.push(`${task.id}: traceability acceptance criteria drift from executable acceptanceCriteria`);
    }
    if (gates.length !== task.verify.length ||
        gates.some((gate, index) => gate.command !== task.verify[index])) {
      errors.push(`${task.id}: traceability gates drift from executable verify commands`);
    }

    for (const criterion of criteria) {
      if (globalCriterionIds.has(criterion.criterionId)) {
        errors.push(`duplicate criterion id: ${criterion.criterionId}`);
      }
      globalCriterionIds.add(criterion.criterionId);
    }

    for (const gate of gates) {
      if (globalGateIds.has(gate.gateId)) errors.push(`duplicate gate id: ${gate.gateId}`);
      globalGateIds.add(gate.gateId);
      if (gate.criterionIds.length === 0) errors.push(`${task.id}: gate ${gate.gateId} must cover at least one criterion`);
      for (const criterionId of gate.criterionIds) {
        if (!taskCriterionIds.has(criterionId)) {
          errors.push(`${task.id}: gate ${gate.gateId} references unknown criterion ${criterionId}`);
        } else {
          coveredCriterionIds.add(criterionId);
        }
      }
    }

    for (const criterionId of taskCriterionIds) {
      if (!coveredCriterionIds.has(criterionId)) {
        errors.push(`${task.id}: criterion ${criterionId} is not covered by a gate`);
      }
    }
  }

  return errors;
}
