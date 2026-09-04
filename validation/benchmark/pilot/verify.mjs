#!/usr/bin/env node
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = resolve(fileURLToPath(new URL(".", import.meta.url)));
const moduleRoot = resolve(here, "../../../modules/ai-code-benchmark");
const { loadPilotSuite } = await import(pathToFileURL(join(moduleRoot, "dist/src/pilot/preregistration.js")).href);
const { buildPilotRepository, PILOT_TASK_IDS, pilotFixtureDigest, pilotSharedConfigHash } = await import(pathToFileURL(join(moduleRoot, "dist/src/pilot/tasks.js")).href);
const { verifyPilotFixtureTransitions } = await import(pathToFileURL(join(moduleRoot, "dist/src/pilot/driver.js")).href);
for (const taskId of PILOT_TASK_IDS) buildPilotRepository(join(here, "repos"), taskId);
const suite = loadPilotSuite(here);
assert.equal(suite.tasks.length, 10, "BENCH-09 must contain exactly ten tasks");
assert.equal(suite.value.arms.length, 3, "BENCH-09 must contain exactly A/B/C");
assert.deepEqual(suite.value.arms.map((arm) => arm.provider), ["codex", "codex", "codex"]);
assert.ok(suite.tasks.every((task) => !/infoapex/iu.test(String(task.value.prompt))), "task prompts must be generic");
const hashes = suite.tasks.map((task) => task.hash); assert.equal(new Set(hashes).size, 10, "task hashes must be distinct");
const transitions = await verifyPilotFixtureTransitions(here, suite.tasks.map((task) => task.value));
assert.deepEqual(transitions, { positiveTransitions: 9, expectedBlockedOracles: 1 });
const experiment = option("--experiment");
if (experiment) { const value = JSON.parse(readFileSync(resolve(experiment), "utf8")); assert.equal(value.maximumInvocations, 30); assert.equal(value.validityGate, 0.9); assert.equal(value.nonAuthoritative, true); assert.match(String(value.protocolHash), /^[a-f0-9]{64}$/); assert.equal(value.protocol.fixtureHash, pilotFixtureDigest()); assert.equal(value.protocol.sharedConfigHash, pilotSharedConfigHash()); assert.equal(value.protocol.isolationPolicy, "trusted-generated-fixtures-only"); }
console.log(JSON.stringify({ status: "PASS", suiteHash: suite.hash, taskCount: suite.tasks.length, transitions, fixtureHash: pilotFixtureDigest(), sharedConfigHash: pilotSharedConfigHash(), experimentChecked: Boolean(experiment) }, null, 2));
function option(name) { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] ?? null : null; }
