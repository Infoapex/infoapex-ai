import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { sha256CanonicalJson } from "./canonical-json.js";
import { assertExperimentMatchesSuite, type LoadedSuite } from "./dataset.js";
import { schemaRegistry } from "./schema-registry.js";

export function freezeExperiment(suite: LoadedSuite, environment: Record<string, unknown>, experimentId = `exp-${randomUUID()}`): Record<string, unknown> {
  schemaRegistry.assertValid("benchmark-environment.schema.json", environment);
  const snapshot = {
    schemaVersion: "1.0",
    id: experimentId,
    suiteId: suite.value.id,
    suiteHash: suite.hash,
    taskHashes: Object.fromEntries(suite.tasks.map((task) => [task.value.id as string, task.hash])),
    environment,
    arms: suite.value.arms,
    repetitions: suite.value.repetitions,
    status: "FROZEN"
  };
  const experiment = { ...snapshot, experimentHash: sha256CanonicalJson(snapshot) };
  schemaRegistry.assertValid("benchmark-experiment.schema.json", experiment);
  assertExperimentMatchesSuite(experiment, suite);
  return experiment;
}

export function freezeSuiteToFile(suite: LoadedSuite, environment: Record<string, unknown>, outputPath: string): Record<string, unknown> {
  const experiment = freezeExperiment(suite, environment);
  writeFileSync(resolve(outputPath), `${JSON.stringify(experiment, null, 2)}\n`, "utf8");
  return experiment;
}
