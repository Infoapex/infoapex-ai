import type { Plan, WorkerManifestTask, WorkerManifestTaskV1_1, ProjectionWarning } from '../types.js';

export function projectToWorkerV1(plan: Plan): {
  manifestTasks: WorkerManifestTask[];
  globalGates: string[];
  projectionWarnings: ProjectionWarning[];
} {
  // Phase 1: the rich Plan schema has no globalGates-equivalent field yet.
  // This is a deliberate documented gap, not a silent omission.
  const globalGates: string[] = [];

  const manifestTasks: WorkerManifestTask[] = [];
  const projectionWarnings: ProjectionWarning[] = [];

  for (const task of plan.tasks) {
    const lostFields: string[] = [];

    // Project acceptanceCriteria: text only, drop criterionId
    const acceptanceCriteria = task.acceptanceCriteria.map((ac, i) => {
      lostFields.push(`acceptanceCriteria[${i}].criterionId`);
      return ac.text;
    });

    // Project gates: command only, drop gateId and evidenceContract
    const verify = task.gates.map((gate, i) => {
      lostFields.push(`gates[${i}].gateId`);
      lostFields.push(`gates[${i}].evidenceContract`);
      return gate.command;
    });

    // Project requiredInputs: ref only, drop kind discriminant
    const requiredInputs = task.requiredInputs.map(ri => ri.ref);

    const manifestTask: WorkerManifestTask = {
      id: task.id,
      kind: inferWorkerKind(task.goal),
      role: task.goal,
      dependsOn: task.dependsOn,
      requiredInputs,
      allowedPaths: task.scope.allowedPaths,
      forbiddenPaths: task.scope.forbiddenPaths,
      expectedArtifacts: [],
      acceptanceCriteria,
      verify,
      concurrencyKeys: task.scope.allowedPaths.length > 0 ? [...task.scope.allowedPaths] : [task.id],
      risk: task.risk ?? 'low',
    };

    if (task.relevantSymbols !== undefined) {
      manifestTask.relevantSymbols = task.relevantSymbols;
    }
    if (task.executionProfile !== undefined) {
      manifestTask.executionProfile = task.executionProfile;
    }

    manifestTasks.push(manifestTask);

    if (lostFields.length > 0) {
      projectionWarnings.push({ taskId: task.id, lostFields });
    }
  }

  return { manifestTasks, globalGates, projectionWarnings };
}

export function projectToWorkerV1_1(plan: Plan): {
  manifestTasks: WorkerManifestTaskV1_1[];
  globalGates: string[];
  projectionWarnings: ProjectionWarning[];
} {
  const legacy = projectToWorkerV1(plan);
  const manifestTasks = legacy.manifestTasks.map((task, index) => ({
    ...task,
    traceability: {
      acceptanceCriteria: plan.tasks[index]!.acceptanceCriteria.map((criterion) => ({ ...criterion })),
      gates: plan.tasks[index]!.gates.map((gate) => ({
        ...gate,
        criterionIds: [...gate.criterionIds]
      }))
    }
  }));

  const projectionWarnings = plan.tasks.flatMap((task) => {
    const lostFields = task.requiredInputs.map((_, index) => `requiredInputs[${index}].kind`);
    return lostFields.length > 0 ? [{ taskId: task.id, lostFields }] : [];
  });

  return { manifestTasks, globalGates: legacy.globalGates, projectionWarnings };
}

function inferWorkerKind(goal: string): WorkerManifestTask['kind'] {
  const text = goal.toLowerCase();
  if (/test|fixture|coverage|lint/.test(text)) return 'test';
  if (/migration|database|sql|schema storage/.test(text)) return 'database';
  if (/contract|openapi|api schema|event schema/.test(text)) return 'contract';
  if (/frontend|react|ui|component|browser|css/.test(text)) return 'frontend';
  if (/backend|server|service|endpoint|api/.test(text)) return 'backend';
  if (/review|audit|security scan/.test(text)) return 'review';
  if (/documentation|docs?|readme/.test(text)) return 'docs';
  if (/repair|fix regression|bug fix/.test(text)) return 'repair';
  return 'other';
}
