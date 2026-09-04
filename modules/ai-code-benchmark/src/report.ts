import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { canonicalJson, sha256CanonicalJson } from "./canonical-json.js";
import { bootstrapMeanConfidenceInterval, describeDistribution, type ConfidenceInterval, type Distribution } from "./statistics.js";
import { schemaRegistry } from "./schema-registry.js";
import { containedPath } from "./security/paths.js";
import { assertObservationMatrix, type ObservationMatrix } from "./runtime/matrix.js";

export type CandidateVerdict = "ACCEPT" | "REJECT" | "INCONCLUSIVE" | "ACCEPT_WITH_LIMITS";
export type MetricName = "success" | "firstPassSuccess" | "scopeSafety" | "totalLatencyMs" | "providerLatencyMs" | "harnessLatencyMs" | "inputTokens" | "outputTokens" | "costUsd" | "humanActiveMinutes" | "retries" | "repairCycles" | "eligibleTraceCoverage" | "telemetryLeakageCount" | "harnessOverheadPercent";

export interface Aggregate {
  readonly value: number | null;
  readonly lower: number | null;
  readonly upper: number | null;
  readonly unit: string;
  readonly sampleCount: number;
  readonly validCount: number;
  readonly missingCount: number;
  readonly completeness: number | null;
  readonly distribution: Distribution;
  readonly method: string;
  readonly seed: string;
}

export interface PairObservation {
  readonly key: string;
  readonly taskId: string;
  readonly repetition: number;
  readonly provider: string;
  readonly environment: string;
  readonly baseline: Record<string, unknown>;
  readonly candidate: Record<string, unknown>;
}

export interface PairingResult {
  readonly pairs: readonly PairObservation[];
  readonly unmatchedBaseline: number;
  readonly unmatchedCandidate: number;
  readonly duplicateKeys: number;
  readonly missingIdentity: number;
}

export interface ReportOptions {
  readonly experimentHash?: string;
  readonly experimentId?: string;
  readonly protocolHash?: string | null;
  readonly protocolHashMismatch?: boolean;
  readonly baselineArmId?: string;
  readonly candidateArmId?: string;
  readonly providerByArm?: Readonly<Record<string, string | null>>;
  readonly environmentId?: string | null;
  readonly expectedObservationCount?: number;
  readonly seed?: string | number;
  readonly generatedAt?: string;
  readonly candidateHypothesis?: Record<string, unknown> | null;
  readonly categories?: Readonly<Record<string, string>>;
  readonly bootstrapSamples?: number;
  /** Internal cross-experiment comparison mode after compatibility checks. */
  readonly allowMultipleExperimentHashes?: boolean;
}

export interface BenchmarkReport {
  readonly schemaVersion: "1.0";
  readonly id: string;
  readonly experimentHash: string;
  readonly verdict: CandidateVerdict;
  readonly aggregates: Readonly<Record<string, Aggregate>>;
  readonly limitations: readonly string[];
  readonly generatedAt: string;
  readonly experimentId?: string;
  readonly protocolHash?: string | null;
  readonly counts?: Readonly<Record<string, number>>;
  readonly comparison?: Record<string, unknown>;
  readonly categories?: Record<string, unknown>;
  readonly verdicts?: Record<string, unknown>;
}

const METRICS: readonly { readonly name: MetricName; readonly unit: string }[] = [
  { name: "success", unit: "ratio" }, { name: "firstPassSuccess", unit: "ratio" }, { name: "scopeSafety", unit: "ratio" },
  { name: "totalLatencyMs", unit: "milliseconds" }, { name: "providerLatencyMs", unit: "milliseconds" }, { name: "harnessLatencyMs", unit: "milliseconds" },
  { name: "inputTokens", unit: "tokens" }, { name: "outputTokens", unit: "tokens" }, { name: "costUsd", unit: "USD" },
  { name: "humanActiveMinutes", unit: "minutes" }, { name: "retries", unit: "count" }, { name: "repairCycles", unit: "count" },
  { name: "eligibleTraceCoverage", unit: "ratio" }, { name: "telemetryLeakageCount", unit: "count" }, { name: "harnessOverheadPercent", unit: "percent" }
];
const LOWER_IS_BETTER = /latency|tokens|cost|minutes|retries|repair|failure|error|violation|leakage|overhead/iu;
const METRIC_ALIASES: Readonly<Record<string, MetricName>> = {
  "verified-task-success": "success", "verifiedTaskSuccess": "success", "task-success": "success", quality: "success",
  "first-pass-success": "firstPassSuccess", "firstPass": "firstPassSuccess", "scope-safety": "scopeSafety", safety: "scopeSafety",
  latency: "totalLatencyMs", "total-latency": "totalLatencyMs", "provider-latency": "providerLatencyMs", "harness-latency": "harnessLatencyMs",
  "input-tokens": "inputTokens", "output-tokens": "outputTokens", cost: "costUsd", "cost-usd": "costUsd", "human-active-minutes": "humanActiveMinutes",
  "repair-cycles": "repairCycles", "eligible-trace-coverage": "eligibleTraceCoverage", "telemetry-safety": "telemetryLeakageCount",
  "telemetry-leakage-count": "telemetryLeakageCount", "harness-overhead-percent": "harnessOverheadPercent"
};
function metricName(value: string): string { return METRIC_ALIASES[value] ?? value; }

function object(value: unknown): Record<string, unknown> | null { return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null; }
function number(value: unknown): number | null { return typeof value === "number" && Number.isFinite(value) ? value : null; }
function text(value: unknown): string | null { return typeof value === "string" && value.length > 0 ? value : null; }
function compareText(left: string, right: string): number { return left < right ? -1 : left > right ? 1 : 0; }
function nested(item: Record<string, unknown>, name: string): number | null {
  const metrics = object(item.metrics); const telemetry = object(item.telemetry); const usage = object(metrics?.usage); const latency = object(metrics?.latency);
  const direct = number(item[name]) ?? number(metrics?.[name]) ?? number(item[Object.entries(METRIC_ALIASES).find(([, canonical]) => canonical === name)?.[0] ?? ""]); if (direct !== null) return direct;
  if (name === "totalLatencyMs") return number(latency?.totalLatencyMs) ?? number(telemetry?.totalLatencyMs) ?? number(telemetry?.elapsedMs) ?? number(item.elapsedMs);
  if (name === "providerLatencyMs") return number(latency?.providerLatencyMs) ?? number(telemetry?.providerLatencyMs);
  if (name === "harnessLatencyMs") return number(latency?.harnessLatencyMs) ?? number(telemetry?.harnessLatencyMs);
  if (name === "inputTokens") return number(usage?.inputUncachedTokens) ?? number(telemetry?.inputTokens) ?? number(item.inputTokens);
  if (name === "outputTokens") return number(usage?.outputTokens) ?? number(telemetry?.outputTokens) ?? number(item.outputTokens);
  if (name === "costUsd") return number(usage?.costUsd) ?? number(telemetry?.costUsd) ?? number(item.costUsd);
  if (name === "scopeSafety") {
    const scope = object(metrics?.scope) ?? object(item.scope); const evaluation = object(item.evaluation);
    const explicit = number(item.scopeSafety); if (explicit !== null) return explicit;
    if (scope?.status === "PASS" || evaluation?.scope && object(evaluation.scope)?.verdict === "PASS") return 1;
    if (scope?.status === "FAIL" || evaluation?.scope && object(evaluation.scope)?.verdict === "FAIL") return 0;
    return item.criticalSafetyFailure === true ? 0 : null;
  }
  if (name === "success") {
    const evaluation = object(item.evaluation); const verdict = text(evaluation?.verdict) ?? text(item.verdict);
    if (verdict) return verdict === "PASS" ? 1 : verdict === "FAIL" || verdict === "BLOCKED" ? 0 : null;
    // Execution status is an agent/runtime claim, not benchmark-owned quality
    // evidence. Only an evaluation verdict or an explicit trusted metric may
    // contribute verified success.
    return null;
  }
  if (name === "firstPassSuccess") return number(item.firstPassSuccess) ?? (item.firstPass === true ? 1 : item.firstPass === false ? 0 : null);
  if (name === "humanActiveMinutes") return number(item.humanActiveMinutes) ?? number(object(item.intervention)?.activeMinutes);
  if (name === "retries") return number(item.retries) ?? number(item.retryCount);
  if (name === "repairCycles") return number(item.repairCycles) ?? number(item.repairs);
  return number(item[name]);
}

function identity(item: Record<string, unknown>, options: ReportOptions): { key: string; taskId: string; repetition: number; provider: string; environment: string } | null {
  const taskId = text(item.taskId); const repetition = number(item.repetition);
  const execution = object(item.execution); const provider = text(item.provider) ?? text(execution?.provider) ?? text(object(item.adapter)?.provider) ?? (options.providerByArm ? text(options.providerByArm[text(item.armId) ?? ""]) : null);
  const rawEnvironment = item.environmentId ?? item.environment ?? execution?.environmentId ?? execution?.environment ?? options.environmentId;
  const environment = rawEnvironment === null || rawEnvironment === undefined ? null : typeof rawEnvironment === "string" ? rawEnvironment : canonicalJson(rawEnvironment);
  if (!taskId || repetition === null || !Number.isInteger(repetition) || !provider || !environment) return null;
  return { taskId, repetition, provider, environment, key: `${taskId}\u0000${repetition}\u0000${provider}\u0000${environment}` };
}

export function pairObservations(observations: readonly Record<string, unknown>[], baselineArmId: string, candidateArmId: string, options: ReportOptions = {}): PairingResult {
  const baseline = new Map<string, Record<string, unknown>[]>(); const candidate = new Map<string, Record<string, unknown>[]>(); let missingIdentity = 0;
  for (const item of observations) {
    const arm = text(item.armId); if (arm !== baselineArmId && arm !== candidateArmId) continue;
    const id = identity(item, options); if (!id) { missingIdentity += 1; continue; }
    const target = arm === baselineArmId ? baseline : candidate; const list = target.get(id.key) ?? []; list.push(item); target.set(id.key, list);
  }
  const keys = [...new Set([...baseline.keys(), ...candidate.keys()])].sort(); const pairs: PairObservation[] = []; let unmatchedBaseline = 0; let unmatchedCandidate = 0; let duplicateKeys = 0;
  for (const key of keys) {
    const left = baseline.get(key) ?? []; const right = candidate.get(key) ?? [];
    if (left.length > 1 || right.length > 1) { duplicateKeys += Math.max(left.length, right.length) - 1; continue; }
    if (left.length === 0) { unmatchedCandidate += right.length; continue; }
    if (right.length === 0) { unmatchedBaseline += left.length; continue; }
    const [taskId, repetitionText, provider, environment] = key.split("\u0000");
    pairs.push({ key, taskId: taskId!, repetition: Number(repetitionText), provider: provider!, environment: environment!, baseline: left[0]!, candidate: right[0]! });
  }
  return { pairs, unmatchedBaseline, unmatchedCandidate, duplicateKeys, missingIdentity };
}

function aggregate(values: readonly (number | null)[], seed: string, unit: string, samples: number): Aggregate {
  const distribution = describeDistribution(values); const interval = bootstrapMeanConfidenceInterval(values, seed, { samples });
  const validCount = values.filter((item) => item !== null).length; const sampleCount = values.length;
  return { value: interval.value, lower: interval.lower, upper: interval.upper, unit, sampleCount, validCount, missingCount: sampleCount - validCount, completeness: sampleCount === 0 ? null : validCount / sampleCount, distribution, method: interval.method, seed: interval.seed };
}

function armIds(observations: readonly Record<string, unknown>[], options: ReportOptions): string[] { return [...new Set(observations.map((item) => text(item.armId)).filter((item): item is string => item !== null))].sort(); }

function validObservation(item: Record<string, unknown>): boolean {
  if (item.valid === false || item.malformed === true) return false;
  if ("status" in item && !["DONE", "BLOCKED", "FAILED", "TIMEOUT"].includes(String(item.status))) return false;
  const verdict = text(object(item.evaluation)?.verdict) ?? text(item.verdict);
  return verdict !== null && ["PASS", "FAIL", "BLOCKED", "INCONCLUSIVE"].includes(verdict);
}
function safetyFailure(item: Record<string, unknown>): boolean { const evaluation = object(item.evaluation); const scope = object(item.scope); return item.criticalSafetyFailure === true || item.safetyCritical === true || evaluation?.criticalSafetyFailure === true || text(object(evaluation?.scope)?.verdict) === "FAIL" || text(scope?.status) === "FAIL" && item.safetyCritical === true || ["policy", "sandbox"].includes(text(object(item.failure)?.kind) ?? ""); }

function categoryOf(item: Record<string, unknown>, options: ReportOptions): string { return text(item.category) ?? (text(item.taskId) && options.categories?.[text(item.taskId)!]) ?? "uncategorized"; }

function thresholdsFor(hypothesis: Record<string, unknown>): Record<string, number> { const raw = object(hypothesis.thresholds); return Object.fromEntries(Object.entries(raw ?? {}).filter(([, value]) => number(value) !== null).map(([key, value]) => [key, number(value)!])); }
function direction(metric: string): "higher" | "lower" { return LOWER_IS_BETTER.test(metric) ? "lower" : "higher"; }

function assessCandidate(hypothesis: Record<string, unknown>, deltas: Record<string, Aggregate>, pairing: PairingResult, options: ReportOptions, protocolMismatch: boolean): { verdict: CandidateVerdict; verdicts: Record<string, string>; limitations: string[] } {
  const verdicts: Record<string, string> = {}; const limitations: string[] = []; const improves = Array.isArray(hypothesis.improves) ? hypothesis.improves.filter((item): item is string => typeof item === "string") : []; const nonRegression = Array.isArray(hypothesis.nonRegression) ? hypothesis.nonRegression.filter((item): item is string => typeof item === "string") : []; const thresholds = thresholdsFor(hypothesis);
  if (protocolMismatch) return { verdict: "INCONCLUSIVE", verdicts, limitations: ["PROTOCOL_HASH_MISMATCH"] };
  for (const declaredMetric of [...improves, ...nonRegression]) {
    const metric = metricName(declaredMetric); const result = deltas[metric]; const threshold = Math.max(0, thresholds[declaredMetric] ?? thresholds[metric] ?? 0);
    if (!result || result.validCount === 0 || result.lower === null || result.upper === null) { verdicts[declaredMetric] = "INCONCLUSIVE"; limitations.push(`INSUFFICIENT_PRIMARY_DATA:${declaredMetric}`); continue; }
    const lowerBetter = direction(metric) === "lower"; const improvePass = lowerBetter ? result.upper <= -threshold : result.lower >= threshold; const nonRegressionPass = lowerBetter ? result.upper <= threshold : result.lower >= -threshold;
    const passed = improves.includes(declaredMetric) ? improvePass : nonRegressionPass; verdicts[declaredMetric] = passed ? "PASS" : "FAIL";
  }
  if (pairing.pairs.length === 0) { limitations.push("INSUFFICIENT_PAIRED_SAMPLES"); return { verdict: "INCONCLUSIVE", verdicts, limitations }; }
  if (improves.some((metric) => verdicts[metric] === "INCONCLUSIVE") || nonRegression.some((metric) => verdicts[metric] === "INCONCLUSIVE")) return { verdict: "INCONCLUSIVE", verdicts, limitations };
  if (nonRegression.some((metric) => verdicts[metric] === "FAIL")) return { verdict: "REJECT", verdicts, limitations };
  if (improves.length > 0 && improves.every((metric) => verdicts[metric] === "PASS")) return { verdict: "ACCEPT", verdicts, limitations };
  if (improves.some((metric) => verdicts[metric] === "PASS")) return { verdict: "ACCEPT_WITH_LIMITS", verdicts, limitations: [...limitations, "SOME_IMPROVEMENT_THRESHOLDS_NOT_MET"] };
  return { verdict: "REJECT", verdicts, limitations: [...limitations, "IMPROVEMENT_THRESHOLD_NOT_MET"] };
}

export function buildBenchmarkReport(observations: readonly Record<string, unknown>[], options: ReportOptions = {}): BenchmarkReport {
  if (options.candidateHypothesis) schemaRegistry.assertValid("candidate-hypothesis.schema.json", options.candidateHypothesis);
  observations = [...observations].sort((left, right) => compareText(String(left.id ?? ""), String(right.id ?? "")) || compareText(canonicalJson(left), canonicalJson(right)));
  const seed = String(options.seed ?? "bench-07"); const arms = armIds(observations, options); const baselineArmId = options.baselineArmId ?? arms[0]; const candidateArmId = options.candidateArmId ?? arms[1];
  const aggregates: Record<string, Aggregate> = {}; const categories: Record<string, Record<string, Aggregate>> = {}; const armCounts: Record<string, number> = {};
  for (const arm of arms) {
    const rows = observations.filter((item) => item.armId === arm); armCounts[arm] = rows.length;
    for (const metric of METRICS) aggregates[`${arm}.${metric.name}`] = aggregate(rows.map((item) => nested(item, metric.name)), `${seed}/${arm}/${metric.name}`, metric.unit, options.bootstrapSamples ?? 2000);
    for (const row of rows) { const category = categoryOf(row, options); const target = categories[category] ?? (categories[category] = {}); for (const metric of METRICS) { const key = `${arm}.${metric.name}`; target[key] ??= aggregate(rows.filter((item) => categoryOf(item, options) === category).map((item) => nested(item, metric.name)), `${seed}/${category}/${key}`, metric.unit, options.bootstrapSamples ?? 2000); } }
  }
  const pairing = baselineArmId && candidateArmId ? pairObservations(observations, baselineArmId, candidateArmId, options) : { pairs: [], unmatchedBaseline: 0, unmatchedCandidate: 0, duplicateKeys: 0, missingIdentity: 0 };
  const deltas: Record<string, Aggregate> = {};
  if (baselineArmId && candidateArmId) for (const metric of METRICS) deltas[metric.name] = aggregate(pairing.pairs.map((pair) => { const left = nested(pair.baseline, metric.name); const right = nested(pair.candidate, metric.name); return left === null || right === null ? null : right - left; }), `${seed}/delta/${metric.name}`, metric.unit, options.bootstrapSamples ?? 2000);
  for (const [metric, value] of Object.entries(deltas)) aggregates[`delta.${candidateArmId ?? "candidate"}.vs.${baselineArmId ?? "baseline"}.${metric}`] = value;
  if (baselineArmId && candidateArmId) {
    for (const category of [...new Set(observations.map((item) => categoryOf(item, options)))].sort()) {
      const target = categories[category] ?? (categories[category] = {}); const categoryPairs = pairing.pairs.filter((pair) => categoryOf(pair.baseline, options) === category && categoryOf(pair.candidate, options) === category);
      for (const metric of METRICS) target[`delta.${candidateArmId}.vs.${baselineArmId}.${metric.name}`] = aggregate(categoryPairs.map((pair) => { const left = nested(pair.baseline, metric.name); const right = nested(pair.candidate, metric.name); return left === null || right === null ? null : right - left; }), `${seed}/${category}/delta/${metric.name}`, metric.unit, options.bootstrapSamples ?? 2000);
    }
  }
  const expected = Math.max(0, options.expectedObservationCount ?? observations.length); const valid = observations.filter(validObservation).length; const limitations: string[] = [];
  const reportedProtocolHashes = observations.map((item) => text(item.protocolHash));
  const experimentMismatch = options.allowMultipleExperimentHashes !== true && options.experimentHash !== undefined && observations.some((item) => text(item.experimentHash) !== options.experimentHash);
  const protocolMismatch = options.protocolHashMismatch === true
    || experimentMismatch
    || (options.protocolHash !== undefined && observations.some((_item, index) => reportedProtocolHashes[index] !== options.protocolHash))
    || new Set(reportedProtocolHashes.filter((item): item is string => item !== null)).size > 1;
  if (expected === 0 || valid / Math.max(1, expected) < 0.9) limitations.push("FEWER_THAN_90_PERCENT_VALID");
  if (pairing.missingIdentity > 0) limitations.push("MISSING_PAIRING_IDENTITY"); if (pairing.unmatchedBaseline || pairing.unmatchedCandidate || pairing.duplicateKeys) limitations.push("UNPAIRED_OBSERVATIONS");
  if (protocolMismatch) limitations.push("PROTOCOL_HASH_MISMATCH"); if (observations.some(safetyFailure)) limitations.push("CRITICAL_SAFETY_FAILURE");
  let verdict: CandidateVerdict = "INCONCLUSIVE"; let verdicts: Record<string, unknown> = {};
  if (observations.some(safetyFailure)) verdict = "REJECT";
  else if (options.candidateHypothesis && baselineArmId && candidateArmId) {
    if (!limitations.includes("FEWER_THAN_90_PERCENT_VALID")) {
      const assessed = assessCandidate(options.candidateHypothesis, deltas, pairing, options, protocolMismatch); verdict = assessed.verdict; verdicts = assessed.verdicts; limitations.push(...assessed.limitations);
    }
  }
  else limitations.push("NO_CANDIDATE_HYPOTHESIS");
  const counts = { expected, valid, invalid: Math.max(0, expected - valid), paired: pairing.pairs.length, unmatchedBaseline: pairing.unmatchedBaseline, unmatchedCandidate: pairing.unmatchedCandidate, duplicateKeys: pairing.duplicateKeys, missingIdentity: pairing.missingIdentity, ...Object.fromEntries(Object.entries(armCounts).map(([arm, count]) => [`arm.${arm}`, count])) };
  const experimentHash = options.experimentHash ?? sha256CanonicalJson({ observations, seed }); const stable = { experimentHash, aggregates, counts, categories, verdict, verdicts, limitations: [...new Set(limitations)].sort() }; const id = `report-${sha256CanonicalJson(stable).slice(0, 40)}`;
  const report: BenchmarkReport = { schemaVersion: "1.0", id, experimentHash, verdict, aggregates, limitations: stable.limitations, generatedAt: options.generatedAt ?? "1970-01-01T00:00:00.000Z", ...(options.experimentId ? { experimentId: options.experimentId } : {}), ...(options.protocolHash !== undefined ? { protocolHash: options.protocolHash } : {}), counts, comparison: { baselineArmId: baselineArmId ?? null, candidateArmId: candidateArmId ?? null, pairedCount: pairing.pairs.length, unmatchedBaseline: pairing.unmatchedBaseline, unmatchedCandidate: pairing.unmatchedCandidate, duplicateKeys: pairing.duplicateKeys, missingIdentity: pairing.missingIdentity, protocolMismatch }, categories, verdicts };
  schemaRegistry.assertValid("benchmark-report.schema.json", report); return report;
}

export const aggregateObservations = buildBenchmarkReport;
export const createReport = buildBenchmarkReport;
export const generateJsonReport = buildBenchmarkReport;
export const pair = pairObservations;
export const pairedComparisons = pairObservations;

export function renderMarkdownReport(report: BenchmarkReport): string {
  const cell = (value: unknown): string => String(value ?? "n/a").replaceAll("\\", "\\\\").replaceAll("|", "\\|").replace(/[\r\n]+/gu, " ");
  const lines = [`# AI code benchmark report`, ``, `- Verdict: ${cell(report.verdict)}`, `- Report: ${cell(report.id)}`, `- Experiment hash: ${cell(report.experimentHash)}`, `- Generated at: ${cell(report.generatedAt)}`, ``, `| Metric | Value | Lower | Upper | N | Valid | Missing | Unit |`, `| --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |`];
  for (const [metric, value] of Object.entries(report.aggregates).sort(([a], [b]) => compareText(a, b))) lines.push(`| ${cell(metric)} | ${cell(value.value)} | ${cell(value.lower)} | ${cell(value.upper)} | ${value.sampleCount} | ${value.validCount} | ${value.missingCount} | ${cell(value.unit)} |`);
  lines.push("", "## Limitations", ""); for (const limitation of report.limitations) lines.push(`- ${cell(limitation)}`); return `${lines.join("\n")}\n`;
}
export const toMarkdown = renderMarkdownReport;
export const generateMarkdownReport = renderMarkdownReport;

export function readExperimentObservations(stateRoot: string, experimentId: string): { readonly experiment: Record<string, unknown>; readonly observations: readonly Record<string, unknown>[] } {
  if (!/^[a-z][a-z0-9-]{2,63}$/u.test(experimentId)) throw new Error("Invalid experiment ID.");
  const root = containedPath(containedPath(stateRoot, "benchmarks"), experimentId);
  const experiment = JSON.parse(readFileSync(containedPath(root, "experiment.json"), "utf8")) as Record<string, unknown>;
  schemaRegistry.assertValid("benchmark-experiment.schema.json", experiment);
  const snapshot = Object.fromEntries(Object.entries(experiment).filter(([key]) => key !== "experimentHash"));
  if (experiment.experimentHash !== sha256CanonicalJson(snapshot)) throw new Error("Frozen experiment hash is invalid.");
  const matrix = JSON.parse(readFileSync(containedPath(root, "matrix.json"), "utf8")) as unknown;
  assertObservationMatrix(matrix, String(experiment.experimentHash));
  const byArm = new Map((experiment.arms as unknown[]).map((item) => { const arm = object(item); return [text(arm?.id) ?? "", text(arm?.provider)] as [string, string | null]; }));
  const environment = text(object(experiment.environment)?.id);
  const observations: Record<string, unknown>[] = [];
  for (const item of (matrix as ObservationMatrix).observations) {
    const terminalPath = containedPath(containedPath(containedPath(containedPath(root, "observations"), item.taskId), item.armId), `${item.repetition}.json`);
    if (!existsSync(terminalPath)) continue;
    const value = JSON.parse(readFileSync(terminalPath, "utf8")) as Record<string, unknown>;
    schemaRegistry.assertValid("benchmark-observation.schema.json", value);
    if (value.id !== item.id || value.experimentHash !== experiment.experimentHash || value.taskId !== item.taskId || value.armId !== item.armId || value.repetition !== item.repetition) throw new Error("Terminal observation does not match the frozen matrix.");
    const executionPath = containedPath(containedPath(containedPath(root, "steps"), item.id), "execution.json");
    const evaluationPath = containedPath(containedPath(root, "evaluations"), `${item.id}.json`);
    const execution = existsSync(executionPath) ? object(JSON.parse(readFileSync(executionPath, "utf8"))) : null;
    const evaluation = existsSync(evaluationPath) ? JSON.parse(readFileSync(evaluationPath, "utf8")) as unknown : null;
    if (evaluation) schemaRegistry.assertValid("benchmark-evaluation.schema.json", evaluation);
    observations.push({ ...value, provider: byArm.get(item.armId) ?? null, environmentId: environment, metrics: execution?.metrics ?? null, evaluation });
  }
  return { experiment, observations: observations.sort((a, b) => compareText(String(a.id), String(b.id))) };
}

export function reportFromState(stateRoot: string, experimentId: string, options: ReportOptions = {}): BenchmarkReport {
  const loaded = readExperimentObservations(stateRoot, experimentId); const experiment = loaded.experiment; const arms = Array.isArray(experiment.arms) ? experiment.arms : []; const expected = Number(experiment.repetitions ?? 1) * Object.keys(object(experiment.taskHashes) ?? {}).length * arms.length; const providers = Object.fromEntries(arms.map((arm) => { const value = object(arm); return [text(value?.id) ?? "", text(value?.provider)]; }));
  const armWithKind = (kind: string): string | undefined => text(object(arms.find((arm) => object(arm)?.kind === kind))?.id) ?? undefined;
  const candidate = options.candidateArmId ?? armWithKind("candidate") ?? armWithKind("full-icm") ?? text(object(arms[1])?.id) ?? undefined;
  const baseline = options.baselineArmId ?? (armWithKind("candidate") ? armWithKind("full-icm") : armWithKind("direct")) ?? text(object(arms[0])?.id) ?? undefined;
  return buildBenchmarkReport(loaded.observations, { ...options, experimentId, experimentHash: text(experiment.experimentHash) ?? options.experimentHash, providerByArm: options.providerByArm ?? providers, environmentId: options.environmentId ?? text(object(experiment.environment)?.id), expectedObservationCount: options.expectedObservationCount ?? expected, baselineArmId: baseline, candidateArmId: candidate });
}

export function compareReports(baseline: BenchmarkReport, candidate: BenchmarkReport, options: { readonly generatedAt?: string; readonly hypothesis?: Record<string, unknown> | null } = {}): BenchmarkReport {
  const observations: Record<string, unknown>[] = []; for (const [key, aggregate] of Object.entries(baseline.aggregates)) { if (!key.includes(".") || key.startsWith("delta.")) continue; const [armId, metric] = key.split("."); if (!armId || !metric) continue; observations.push({ taskId: `aggregate-${armId}`, repetition: 1, armId: "baseline", provider: "aggregate", environmentId: "aggregate", [metric]: aggregate.value }); }
  for (const [key, aggregate] of Object.entries(candidate.aggregates)) { if (!key.includes(".") || key.startsWith("delta.")) continue; const [armId, metric] = key.split("."); if (!armId || !metric) continue; observations.push({ taskId: `aggregate-${armId}`, repetition: 1, armId: "candidate", provider: "aggregate", environmentId: "aggregate", [metric]: aggregate.value }); }
  return buildBenchmarkReport(observations, { experimentHash: candidate.experimentHash, baselineArmId: "baseline", candidateArmId: "candidate", candidateHypothesis: options.hypothesis, generatedAt: options.generatedAt, expectedObservationCount: observations.length });
}

/** Compare two frozen runs. Observations are kept at task/repetition/provider/
 * environment granularity; an arm aggregate is never treated as a pair. */
export function compareExperimentStates(stateRoot: string, baselineId: string, candidateId: string, options: ReportOptions = {}): BenchmarkReport {
  const baseline = readExperimentObservations(stateRoot, baselineId); const candidate = readExperimentObservations(stateRoot, candidateId);
  const armByKind = (experiment: Record<string, unknown>, kinds: readonly string[]): string | null => {
    const arms = Array.isArray(experiment.arms) ? experiment.arms : [];
    for (const kind of kinds) { const found = arms.find((arm) => object(arm)?.kind === kind); const id = text(object(found)?.id); if (id) return id; }
    return text(object(arms[0])?.id);
  };
  const baselineSourceArm = armByKind(baseline.experiment, ["full-icm", "direct"]);
  const candidateSourceArm = armByKind(candidate.experiment, ["candidate", "full-icm"]);
  const left = baseline.observations.filter((item) => item.armId === baselineSourceArm).map((item) => ({ ...item, sourceArmId: item.armId, armId: "baseline", environmentId: "comparison" }));
  const right = candidate.observations.filter((item) => item.armId === candidateSourceArm).map((item) => ({ ...item, sourceArmId: item.armId, armId: "candidate", environmentId: "comparison" }));
  const expectedLeft = Number(baseline.experiment.repetitions ?? 1) * Object.keys(object(baseline.experiment.taskHashes) ?? {}).length;
  const expectedRight = Number(candidate.experiment.repetitions ?? 1) * Object.keys(object(candidate.experiment.taskHashes) ?? {}).length;
  const commonEnvironment = (experiment: Record<string, unknown>): unknown => { const environment = object(experiment.environment); return environment ? { os: environment.os, architecture: environment.architecture, toolchain: environment.toolchain } : null; };
  const incompatible = canonicalJson(baseline.experiment.taskHashes) !== canonicalJson(candidate.experiment.taskHashes)
    || baseline.experiment.repetitions !== candidate.experiment.repetitions
    || canonicalJson(commonEnvironment(baseline.experiment)) !== canonicalJson(commonEnvironment(candidate.experiment));
  return buildBenchmarkReport([...left, ...right], { ...options, experimentId: `${baselineId}-vs-${candidateId}`, experimentHash: text(candidate.experiment.experimentHash) ?? options.experimentHash, baselineArmId: "baseline", candidateArmId: "candidate", expectedObservationCount: options.expectedObservationCount ?? Math.max(expectedLeft, expectedRight) * 2, providerByArm: { baseline: "comparison", candidate: "comparison" }, environmentId: options.environmentId ?? "comparison", protocolHashMismatch: options.protocolHashMismatch === true || incompatible, allowMultipleExperimentHashes: true });
}
