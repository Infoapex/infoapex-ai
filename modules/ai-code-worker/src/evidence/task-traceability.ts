import type { ManifestTaskTraceability } from "../manifest/traceability.js";
import type { QualityGateResult } from "../runner/quality-gate.js";

export interface EvidenceTraceableTask {
  readonly id: string;
  readonly traceability?: ManifestTaskTraceability;
}

export function buildTaskEvidenceTraceability(
  task: EvidenceTraceableTask,
  commands: readonly QualityGateResult[]
): {
  readonly taskId: string;
  readonly criterionIds: readonly string[];
  readonly gates: readonly {
    readonly gateId: string;
    readonly criterionIds: readonly string[];
    readonly evidenceContract: string;
    readonly commandId: string | null;
  }[];
} | null {
  if (!task.traceability) return null;

  return {
    taskId: task.id,
    criterionIds: task.traceability.acceptanceCriteria.map((criterion) => criterion.criterionId),
    gates: task.traceability.gates.map((gate, index) => ({
      gateId: gate.gateId,
      criterionIds: [...gate.criterionIds],
      evidenceContract: gate.evidenceContract,
      commandId: commands[index]?.id ?? null
    }))
  };
}
