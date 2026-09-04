import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { sha256CanonicalJson } from "../canonical-json.js";
import { freezeExperiment } from "../experiment.js";
import { loadSuite, type LoadedSuite } from "../dataset.js";
import { pilotFixtureDigest, pilotSharedConfigHash } from "./tasks.js";

export const PILOT_MODEL = "gpt-5.6-luna" as const;
export const PILOT_EFFORT = "medium" as const;
export const PILOT_MAX_INVOCATIONS = 30 as const;
export const PILOT_VALIDITY_GATE = 0.9 as const;
export const PILOT_LIMITATIONS = ["directional BENCH-P sample; not a product ranking", "one provider only; results do not generalize to other providers", "fake runs validate the harness and are excluded from live verdicts", "account gauges and self-reported usage are contextual, never authoritative", "provider outage, quota, policy, and implementation failures remain distinct"] as const;

export function pilotSuitePath(root = resolve("validation/benchmark/pilot")): string { return resolve(root, "suite.json"); }
export function loadPilotSuite(root?: string): LoadedSuite { return loadSuite(pilotSuitePath(root)); }

export function createPilotExperiment(suite: LoadedSuite, environment: Record<string, unknown>, experimentId = "bench-09-pilot-codex"): Record<string, unknown> {
  const base = freezeExperiment(suite, environment, experimentId);
  const protocol = { protocolVersion: "bench-09.v1", suiteHash: suite.hash, taskHashes: Object.fromEntries(suite.tasks.map((task) => [task.value.id, task.hash])), fixtureHash: pilotFixtureDigest(), sharedConfigHash: pilotSharedConfigHash(), arms: suite.value.arms, repetitions: suite.value.repetitions, provider: "codex", model: PILOT_MODEL, effort: PILOT_EFFORT, maximumInvocations: PILOT_MAX_INVOCATIONS, validityGate: PILOT_VALIDITY_GATE, limitations: PILOT_LIMITATIONS, seedPolicy: "sha256 experiment/task/arm/repetition; balanced Latin rotation", oracleAccess: "evaluator-only", fallbackPolicy: "none", isolationPolicy: "trusted-generated-fixtures-only" };
  const protocolHash = sha256CanonicalJson(protocol);
  const { experimentHash: _baseHash, ...baseSnapshot } = base;
  const snapshot = { ...baseSnapshot, protocolHash, protocol, nonAuthoritative: true, maximumInvocations: PILOT_MAX_INVOCATIONS, validityGate: PILOT_VALIDITY_GATE, limitations: PILOT_LIMITATIONS };
  return { ...snapshot, experimentHash: sha256CanonicalJson(snapshot) };
}

export function writePilotExperiment(experiment: Record<string, unknown>, path: string): void { writeFileSync(resolve(path), `${JSON.stringify(experiment, null, 2)}\n`, "utf8"); }
export function readPilotExperiment(path: string): Record<string, unknown> { if (!existsSync(path)) throw new Error(`Missing frozen pilot experiment: ${path}`); return JSON.parse(readFileSync(resolve(path), "utf8")) as Record<string, unknown>; }
