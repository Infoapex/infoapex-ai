export interface ManifestCriterionTrace {
  readonly criterionId: string;
  readonly text: string;
}

export interface ManifestGateTrace {
  readonly gateId: string;
  readonly command: string;
  readonly evidenceContract: string;
  readonly criterionIds: readonly string[];
}

export interface ManifestTaskTraceability {
  readonly acceptanceCriteria: readonly ManifestCriterionTrace[];
  readonly gates: readonly ManifestGateTrace[];
}

export interface TraceableManifestTask {
  readonly id: string;
  readonly acceptanceCriteria: readonly string[];
  readonly verify: readonly string[];
  readonly traceability: ManifestTaskTraceability;
}

export function validateManifestTraceability(manifest: {
  readonly schemaVersion: string;
  readonly tasks: readonly TraceableManifestTask[];
}): string[] {
  if (manifest.schemaVersion !== "1.1") return [];

  const errors: string[] = [];
  const criterionIds = new Set<string>();
  const gateIds = new Set<string>();

  for (const task of manifest.tasks) {
    const taskCriterionIds = new Set(task.traceability.acceptanceCriteria.map((criterion) => criterion.criterionId));
    const coveredCriterionIds = new Set<string>();

    if (task.acceptanceCriteria.length !== task.traceability.acceptanceCriteria.length ||
        task.traceability.acceptanceCriteria.some((criterion, index) => criterion.text !== task.acceptanceCriteria[index])) {
      errors.push(`${task.id}: traceability acceptance criteria do not match executable acceptanceCriteria`);
    }
    if (task.verify.length !== task.traceability.gates.length ||
        task.traceability.gates.some((gate, index) => gate.command !== task.verify[index])) {
      errors.push(`${task.id}: traceability gates do not match executable verify commands`);
    }

    for (const criterion of task.traceability.acceptanceCriteria) {
      if (criterionIds.has(criterion.criterionId)) errors.push(`duplicate criterion id: ${criterion.criterionId}`);
      criterionIds.add(criterion.criterionId);
    }

    for (const gate of task.traceability.gates) {
      if (gateIds.has(gate.gateId)) errors.push(`duplicate gate id: ${gate.gateId}`);
      gateIds.add(gate.gateId);
      for (const criterionId of gate.criterionIds) {
        if (!taskCriterionIds.has(criterionId)) {
          errors.push(`${task.id}: gate ${gate.gateId} references unknown criterion ${criterionId}`);
        } else {
          coveredCriterionIds.add(criterionId);
        }
      }
    }

    for (const criterionId of taskCriterionIds) {
      if (!coveredCriterionIds.has(criterionId)) errors.push(`${task.id}: criterion ${criterionId} is not covered by a gate`);
    }
  }

  return errors;
}
