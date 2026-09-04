import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createAdapter } from "../adapters/registry.js";
import { sha256CanonicalJson } from "../canonical-json.js";
import { parseConfig } from "../config.js";
import { assertExperimentMatchesSuite, type LoadedSuite } from "../dataset.js";
import { evaluateExperiment } from "../evaluation/index.js";
import { freezeExperiment } from "../experiment.js";
import { readJson } from "../persistence/store.js";
import { buildBenchmarkReport, renderMarkdownReport } from "../report.js";
import { runExperiment, resumeExperiment, type ObservationExecutor } from "../runtime/index.js";
import { schemaRegistry } from "../schema-registry.js";
import type { BenchmarkConfig } from "../types.js";
import { executePilotObservation } from "../pilot/driver.js";
import { assertTrustedPilotCampaign, buildPilotCampaignRepository, pilotFixtureDigest, pilotSharedConfigHash } from "../pilot/tasks.js";
import { loadPilotSuite, PILOT_EFFORT, PILOT_LIMITATIONS, PILOT_MODEL, PILOT_VALIDITY_GATE } from "../pilot/preregistration.js";
import { OTEL_CANDIDATE_MAX_INVOCATIONS, validateOtelCandidateAuthorization } from "./authorization.js";

export const OTEL_CANDIDATE_SUITE_ID = "p5-otel-live-v1" as const;
export const OTEL_CANDIDATE_CAPABILITY = "opentelemetry-redacted-v1" as const;

export interface OtelCandidateRunOptions {
  readonly suiteRoot: string;
  readonly repositoryPath: string;
  readonly stateRoot: string;
  readonly experimentPath: string;
  readonly configPath: string;
  readonly hypothesisPath: string;
  readonly authorizationPath: string;
  readonly maximumNewObservations?: number;
  readonly resume?: boolean;
}

export function loadOtelCandidateSuite(suiteRoot: string): LoadedSuite {
  const base = loadPilotSuite(suiteRoot);
  const value = {
    ...base.value,
    id: OTEL_CANDIDATE_SUITE_ID,
    arms: [
      { id: "full-icm", kind: "full-icm", provider: "codex", model: PILOT_MODEL, effort: PILOT_EFFORT },
      { id: "candidate", kind: "candidate", provider: "codex", model: PILOT_MODEL, effort: PILOT_EFFORT }
    ],
    budgets: { maximumInvocations: OTEL_CANDIDATE_MAX_INVOCATIONS, maximumMinutes: 120, maximumCostUsd: null },
    labels: { treatment: "INFOAPEX_OTEL_ENABLED", baseline: "disabled", candidate: "enabled-redacted-local-file" }
  };
  schemaRegistry.assertValid("benchmark-suite.schema.json", value);
  return { ...base, value, hash: sha256CanonicalJson(value) };
}

export function createOtelCandidateExperiment(input: { readonly suiteRoot: string; readonly hypothesis: Record<string, unknown>; readonly environment: Record<string, unknown>; readonly experimentId: string; readonly baselineExperimentHash: string }): Record<string, unknown> {
  schemaRegistry.assertValid("candidate-hypothesis.schema.json", input.hypothesis);
  const suite = loadOtelCandidateSuite(input.suiteRoot);
  if (input.hypothesis.suiteId !== OTEL_CANDIDATE_SUITE_ID) throw new Error("OpenTelemetry hypothesis does not target the frozen candidate suite.");
  const base = freezeExperiment(suite, input.environment, input.experimentId);
  const hypothesisHash = sha256CanonicalJson(input.hypothesis);
  const protocol = {
    protocolVersion: "p5-otel.v1",
    suiteHash: suite.hash,
    taskHashes: Object.fromEntries(suite.tasks.map((task) => [String(task.value.id), task.hash])),
    fixtureHash: pilotFixtureDigest(),
    sharedConfigHash: pilotSharedConfigHash(),
    baselineExperimentHash: input.baselineExperimentHash,
    hypothesisHash,
    provider: "codex",
    model: PILOT_MODEL,
    effort: PILOT_EFFORT,
    arms: suite.value.arms,
    treatment: { baseline: { INFOAPEX_OTEL_ENABLED: null }, candidate: { INFOAPEX_OTEL_ENABLED: "1" } },
    maximumInvocations: OTEL_CANDIDATE_MAX_INVOCATIONS,
    validityGate: PILOT_VALIDITY_GATE,
    fallbackPolicy: "none",
    oracleAccess: "evaluator-only",
    isolationPolicy: "trusted-generated-fixtures-only"
  };
  const { experimentHash: _baseHash, ...baseSnapshot } = base;
  const snapshot = { ...baseSnapshot, protocolHash: sha256CanonicalJson(protocol), protocol, nonAuthoritative: true, maximumInvocations: OTEL_CANDIDATE_MAX_INVOCATIONS, validityGate: PILOT_VALIDITY_GATE, limitations: [...PILOT_LIMITATIONS, "candidate implementation predates the frozen live-evaluation hypothesis"] };
  return { ...snapshot, experimentHash: sha256CanonicalJson(snapshot) };
}

export async function runOtelCandidate(options: OtelCandidateRunOptions): Promise<Record<string, unknown>> {
  const suite = loadOtelCandidateSuite(options.suiteRoot);
  const experiment = readJson<Record<string, unknown>>(resolve(options.experimentPath));
  const hypothesis = readJson<Record<string, unknown>>(resolve(options.hypothesisPath));
  schemaRegistry.assertValid("candidate-hypothesis.schema.json", hypothesis);
  assertExperimentMatchesSuite(experiment, suite);
  const snapshot = Object.fromEntries(Object.entries(experiment).filter(([key]) => key !== "experimentHash"));
  if (experiment.experimentHash !== sha256CanonicalJson(snapshot)) throw new Error("P5 candidate experiment hash is invalid.");
  const protocol = record(experiment.protocol) ?? {};
  const hypothesisHash = sha256CanonicalJson(hypothesis);
  if (protocol.hypothesisHash !== hypothesisHash || protocol.fixtureHash !== pilotFixtureDigest() || protocol.sharedConfigHash !== pilotSharedConfigHash() || experiment.maximumInvocations !== OTEL_CANDIDATE_MAX_INVOCATIONS) throw new Error("Frozen P5 candidate protocol does not match its hypothesis or trusted fixtures.");
  validateOtelCandidateAuthorization(options.authorizationPath, { experimentId: String(experiment.id), experimentHash: String(experiment.experimentHash), hypothesisHash });

  const config = parseConfig(JSON.parse(readFileSync(resolve(options.configPath), "utf8")));
  if (config.capabilities.liveExecution !== true) throw new Error("P5 candidate live execution is disabled in the benchmark config.");
  const runtimePath = join(resolve(options.stateRoot), "benchmarks", String(experiment.id), "runtime.json");
  const source = options.resume && existsSync(runtimePath) ? String(readJson<Record<string, unknown>>(runtimePath).repositoryPath) : mkdtempSync(join(tmpdir(), "p5-otel-trusted-source-"));
  if (!existsSync(join(source, "tasks"))) buildPilotCampaignRepository(source, suite.tasks.map((task) => task.value));
  assertTrustedPilotCampaign(source, suite.tasks.map((task) => task.value));

  const adapters = new Map([
    ["full-icm", createAdapter("infoapex", config)],
    ["candidate", createAdapter("infoapex", config)]
  ]);
  const tasks = new Map(suite.tasks.map((task) => [String(task.value.id), task.value]));
  const executor: ObservationExecutor = { execute: async (request) => executePilotObservation(request, adapters, config, tasks, false, OTEL_CANDIDATE_CAPABILITY) };
  const runtimeOptions = { stateRoot: options.stateRoot, repositoryPath: source, executor, concurrency: 1, timeoutMs: 135_000, maximumNewObservations: options.maximumNewObservations } as const;
  const runtime = options.resume ? await resumeExperiment({ ...runtimeOptions, experimentId: String(experiment.id) }) : await runExperiment({ ...runtimeOptions, experiment });
  const evaluated = await evaluateExperiment({ stateRoot: options.stateRoot, experimentId: String(experiment.id), suite });

  const root = join(resolve(options.stateRoot), "benchmarks", String(experiment.id));
  const terminalById = new Map(runtime.observations.map((item) => [String(item.id), item]));
  const executionById = new Map<string, Record<string, unknown>>();
  for (const item of runtime.observations) executionById.set(String(item.id), readJson<Record<string, unknown>>(join(root, "steps", String(item.id), "execution.json")));
  const latencyByTask = new Map<string, { baseline: number | null; candidate: number | null }>();
  for (const item of runtime.observations) {
    const execution = executionById.get(String(item.id)); const metrics = record(execution?.metrics); const latency = record(metrics?.latency);
    const row = latencyByTask.get(String(item.taskId)) ?? { baseline: null, candidate: null };
    const value = finite(latency?.providerLatencyMs);
    if (item.armId === "full-icm") row.baseline = value; else if (item.armId === "candidate") row.candidate = value;
    latencyByTask.set(String(item.taskId), row);
  }
  const environmentId = String(record(experiment.environment)?.id ?? "unknown");
  const categories = Object.fromEntries(suite.tasks.map((task) => [String(task.value.id), String(task.value.kind)]));
  const observations = evaluated.results.map((evaluation) => {
    const terminal = terminalById.get(evaluation.observationId); const execution = executionById.get(evaluation.observationId); const metrics = record(execution?.metrics);
    const armId = String(terminal?.armId ?? "unknown"); const latencies = latencyByTask.get(evaluation.taskId); const overhead = latencies?.baseline !== null && latencies?.baseline !== undefined && latencies.baseline > 0 && latencies.candidate !== null ? ((latencies.candidate - latencies.baseline) / latencies.baseline) * 100 : null;
    return {
      taskId: evaluation.taskId, armId, repetition: Number(terminal?.repetition ?? 1), provider: "codex", environmentId,
      verdict: evaluation.verdict, evaluation, criticalSafetyFailure: evaluation.criticalSafetyFailure,
      scopeSafety: evaluation.scope.verdict === "PASS" ? 1 : 0, verifiedTaskSuccess: evaluation.verdict === "PASS" ? 1 : 0,
      firstPassSuccess: evaluation.verdict === "PASS" ? 1 : 0, humanActiveMinutes: 0, metrics,
      eligibleTraceCoverage: finite(metrics?.eligibleTraceCoverage), telemetryLeakageCount: finite(metrics?.telemetryLeakageCount),
      harnessOverheadPercent: armId === "full-icm" ? 0 : overhead,
      experimentHash: experiment.experimentHash, protocolHash: experiment.protocolHash
    };
  });
  const report = buildBenchmarkReport(observations, {
    experimentId: String(experiment.id), experimentHash: String(experiment.experimentHash), protocolHash: String(experiment.protocolHash),
    providerByArm: { "full-icm": "codex", candidate: "codex" }, environmentId, categories,
    expectedObservationCount: OTEL_CANDIDATE_MAX_INVOCATIONS, baselineArmId: "full-icm", candidateArmId: "candidate",
    candidateHypothesis: hypothesis, generatedAt: new Date().toISOString()
  });

  mkdirSync(join(root, "raw-private"), { recursive: true }); mkdirSync(join(root, "redacted"), { recursive: true });
  writeFileSync(join(root, "raw-private", "index.json"), `${JSON.stringify({ schemaVersion: "p5-otel-raw.v1", experimentHash: experiment.experimentHash, note: "Raw provider, worker event, and span records remain private; only aggregate trace evidence is exported." }, null, 2)}\n`, "utf8");
  writeFileSync(join(root, "redacted", "REPORT.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
  writeFileSync(join(root, "redacted", "REPORT.md"), renderMarkdownReport(report), "utf8");
  writeFileSync(join(root, "redacted", "TRACE-EVIDENCE.json"), `${JSON.stringify({ schemaVersion: "p5-otel-trace-evidence.v1", experimentHash: experiment.experimentHash, observations: observations.map((item) => ({ taskId: item.taskId, armId: item.armId, traceExpected: finite(record(item.metrics?.evidence)?.traceExpected), tracePresent: finite(record(item.metrics?.evidence)?.tracePresent), eligibleTraceCoverage: item.eligibleTraceCoverage, telemetryLeakageCount: item.telemetryLeakageCount })) }, null, 2)}\n`, "utf8");
  writeFileSync(join(root, "redacted", "candidate-hypothesis.json"), `${JSON.stringify(hypothesis, null, 2)}\n`, "utf8");
  writeFileSync(join(root, "interventions.jsonl"), `${JSON.stringify({ schemaVersion: "p5-otel-intervention.v1", experimentHash: experiment.experimentHash, action: "none", durationMinutes: 0, reason: "No manual intervention was performed." })}\n`, "utf8");
  return { runtime, evaluated: { count: evaluated.evaluated, skipped: evaluated.skipped }, report, hypothesisHash, traceEvidence: join(root, "redacted", "TRACE-EVIDENCE.json") };
}

function record(value: unknown): Record<string, any> | null { return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, any> : null; }
function finite(value: unknown): number | null { return typeof value === "number" && Number.isFinite(value) ? value : null; }
