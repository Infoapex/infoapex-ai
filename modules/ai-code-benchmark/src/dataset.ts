import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { sha256CanonicalJson } from "./canonical-json.js";
import { schemaRegistry } from "./schema-registry.js";

export interface LoadedTask {
  readonly path: string;
  readonly value: Record<string, unknown>;
  readonly hash: string;
}

export interface LoadedSuite {
  readonly path: string;
  readonly value: Record<string, unknown>;
  readonly hash: string;
  readonly tasks: readonly LoadedTask[];
}

/** Reject snapshots that claim a suite, task, or arm which the frozen suite does not contain. */
export function assertExperimentMatchesSuite(experiment: Record<string, unknown>, suite: LoadedSuite): void {
  if (experiment.suiteId !== suite.value.id || experiment.suiteHash !== suite.hash) throw new Error("Experiment references a different suite or suite hash.");
  const taskHashes = experiment.taskHashes;
  if (!isRecord(taskHashes)) throw new Error("Experiment taskHashes must be an object.");
  const expected = new Map(suite.tasks.map((task) => [task.value.id as string, task.hash]));
  if (Object.keys(taskHashes).length !== expected.size) throw new Error("Experiment contains dangling or missing task IDs.");
  for (const [id, hash] of Object.entries(taskHashes)) if (expected.get(id) !== hash) throw new Error(`Experiment contains dangling task ID or hash: ${id}`);
  const arms = experiment.arms;
  if (!Array.isArray(arms)) throw new Error("Experiment arms must be an array.");
  if (sha256CanonicalJson(arms) !== sha256CanonicalJson(suite.value.arms)) throw new Error("Experiment arms differ from the frozen suite arms.");
  const expectedArms = new Set((suite.value.arms as Array<Record<string, unknown>>).map((arm) => arm.id));
  for (const arm of arms) if (!isRecord(arm) || !expectedArms.has(arm.id)) throw new Error("Experiment contains a dangling arm ID.");
}

export function loadSuite(suitePath: string): LoadedSuite {
  const path = resolve(suitePath);
  const suite = readJson(path, "benchmark-suite.schema.json");
  const taskFiles = suite.taskFiles as unknown[];
  const root = dirname(path);
  const tasks = taskFiles.map((taskFile) => {
    if (typeof taskFile !== "string") throw new Error("suite.taskFiles must contain strings.");
    const taskPath = resolveContained(root, taskFile);
    return { path: taskPath, value: readJson(taskPath, "benchmark-task.schema.json") };
  });
  const ids = new Set<string>();
  for (const task of tasks) {
    const id = task.value.id as string;
    if (ids.has(id)) throw new Error(`Duplicate task id in suite: ${id}`);
    ids.add(id);
  }
  return {
    path,
    value: suite,
    hash: sha256CanonicalJson(suite),
    tasks: tasks.map((task) => ({ ...task, hash: sha256CanonicalJson(task.value) }))
  };
}

export function resolveContained(root: string, input: string): string {
  if (input.length === 0 || isAbsolute(input) || input.includes("\\")) throw new Error(`Invalid relative dataset path: ${input}`);
  const candidate = resolve(root, input);
  const lexicalRemainder = relative(root, candidate);
  if (lexicalRemainder === "" || lexicalRemainder === ".." || lexicalRemainder.startsWith(`..${sep}`) || isAbsolute(lexicalRemainder)) {
    throw new Error(`Dataset path escapes suite directory: ${input}`);
  }
  if (!existsSync(candidate)) throw new Error(`Dataset file does not exist: ${input}`);
  const realRoot = realpathSync(root);
  const realCandidate = realpathSync(candidate);
  const remainder = relative(realRoot, realCandidate);
  if (remainder === "" || remainder === ".." || remainder.startsWith(`..${sep}`) || isAbsolute(remainder)) {
    throw new Error(`Dataset path escapes suite directory: ${input}`);
  }
  return realCandidate;
}

function readJson(path: string, schema: string): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`Unable to read JSON ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
  schemaRegistry.assertValid(schema, value);
  return value as Record<string, unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
