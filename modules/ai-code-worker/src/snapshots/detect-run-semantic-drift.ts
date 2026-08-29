import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { SemanticInvalidationReason } from "./incremental-invalidation.js";
import { semanticInputInvalidationReasons } from "./incremental-invalidation.js";
import type { SemanticTaskInputs } from "./semantic-task-inputs.js";
import type { TaskInputSnapshot } from "./task-input-snapshot.js";

export interface RunSemanticDrift {
  readonly taskId: string;
  readonly reasons: readonly SemanticInvalidationReason[];
}

export function detectRunSemanticDrift(
  runRoot: string,
  currentInputs: Readonly<Record<string, SemanticTaskInputs>>
): readonly RunSemanticDrift[] {
  const drift: RunSemanticDrift[] = [];

  for (const taskId of Object.keys(currentInputs).sort()) {
    const path = join(runRoot, "tasks", taskId, "task-input.json");
    if (!existsSync(path)) continue;
    let previous: TaskInputSnapshot;
    try {
      previous = JSON.parse(readFileSync(path, "utf8")) as TaskInputSnapshot;
    } catch {
      drift.push({ taskId, reasons: ["SNAPSHOT_UNREADABLE"] });
      continue;
    }
    if (
      previous.schemaVersion !== "1.1" ||
      typeof previous.qualityGateConfigHash !== "string" ||
      typeof previous.policyHash !== "string" ||
      typeof previous.toolchainConfigHash !== "string" ||
      !Array.isArray(previous.contractHashes)
    ) {
      drift.push({ taskId, reasons: ["SNAPSHOT_UNREADABLE"] });
      continue;
    }
    const reasons = semanticInputInvalidationReasons(previous, currentInputs[taskId]!);
    if (reasons.length > 0) drift.push({ taskId, reasons });
  }

  return drift;
}
