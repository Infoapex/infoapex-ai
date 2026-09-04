import { createHash } from "node:crypto";

export interface ObservationPlan {
  readonly id: string;
  readonly key: string;
  readonly taskId: string;
  readonly armId: string;
  readonly repetition: number;
  readonly seed: number;
  readonly order: number;
}

export interface ObservationMatrix {
  readonly schemaVersion: "1.0";
  readonly experimentHash: string;
  readonly seed: number;
  readonly observations: readonly ObservationPlan[];
}

function digest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function uint31(value: string): number {
  return (Number.parseInt(digest(value).slice(0, 8), 16) & 0x7fff_ffff) || 1;
}

/** A deterministic Latin rotation balances each arm across order positions per task. */
export function createObservationMatrix(experiment: Record<string, unknown>): ObservationMatrix {
  const experimentHash = requiredString(experiment.experimentHash, "experimentHash");
  const repetitions = experiment.repetitions;
  if (!Number.isInteger(repetitions) || (repetitions as number) < 1) throw new Error("Experiment repetitions must be a positive integer.");
  if (!experiment.taskHashes || typeof experiment.taskHashes !== "object" || Array.isArray(experiment.taskHashes)) throw new Error("Experiment taskHashes must be an object.");
  if (!Array.isArray(experiment.arms) || experiment.arms.length === 0) throw new Error("Experiment arms must be a non-empty array.");
  const tasks = Object.keys(experiment.taskHashes as Record<string, unknown>).sort();
  const arms = experiment.arms.map((arm, index) => {
    if (!arm || typeof arm !== "object" || Array.isArray(arm)) throw new Error(`Invalid arm at index ${index}.`);
    return requiredString((arm as Record<string, unknown>).id, `arms[${index}].id`);
  });
  if (new Set(arms).size !== arms.length) throw new Error("Experiment arm IDs must be unique.");
  const observations: ObservationPlan[] = [];
  for (const taskId of tasks) {
    const base = uint31(`${experimentHash}/${taskId}/arm-order`) % arms.length;
    for (let repetition = 1; repetition <= (repetitions as number); repetition += 1) {
      for (let position = 0; position < arms.length; position += 1) {
        const armId = arms[(base + repetition - 1 + position) % arms.length]!;
        const key = `${experimentHash}/${taskId}/${armId}/${repetition}`;
        observations.push({ id: `obs-${digest(key).slice(0, 40)}`, key, taskId, armId, repetition, seed: uint31(`${key}/seed`), order: observations.length });
      }
    }
  }
  return { schemaVersion: "1.0", experimentHash, seed: uint31(`${experimentHash}/matrix`), observations };
}

export function assertObservationMatrix(value: unknown, experimentHash?: string): asserts value is ObservationMatrix {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Observation matrix must be an object.");
  const matrix = value as Record<string, unknown>;
  if (Object.keys(matrix).sort().join("|") !== "experimentHash|observations|schemaVersion|seed") throw new Error("Observation matrix has unknown or missing properties.");
  if (matrix.schemaVersion !== "1.0" || typeof matrix.experimentHash !== "string" || !Number.isInteger(matrix.seed) || !Array.isArray(matrix.observations)) throw new Error("Invalid observation matrix header.");
  if (experimentHash && matrix.experimentHash !== experimentHash) throw new Error("Observation matrix belongs to another experiment.");
  const ids = new Set<string>();
  const keys = new Set<string>();
  matrix.observations.forEach((raw, order) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Invalid observation matrix entry.");
    const item = raw as Record<string, unknown>;
    const exact = ["armId", "id", "key", "order", "repetition", "seed", "taskId"];
    if (Object.keys(item).sort().join("|") !== exact.join("|")) throw new Error("Observation matrix entry has unknown or missing properties.");
    for (const key of ["id", "key", "taskId", "armId"] as const) if (typeof item[key] !== "string" || item[key].length === 0) throw new Error(`Invalid observation ${key}.`);
    if (item.order !== order || !Number.isInteger(item.repetition) || (item.repetition as number) < 1 || !Number.isInteger(item.seed) || (item.seed as number) < 1) throw new Error("Invalid observation ordering, repetition, or seed.");
    if (ids.has(item.id as string) || keys.has(item.key as string)) throw new Error("Duplicate observation ID or idempotency key.");
    ids.add(item.id as string); keys.add(item.key as string);
  });
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`Experiment ${label} must be a non-empty string.`);
  return value;
}
