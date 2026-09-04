import { createHash } from "node:crypto";
import { appendFileSync, existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { mkdirSync } from "node:fs";
import { sha256CanonicalJson, canonicalJson } from "../canonical-json.js";
import { assessScope } from "../metrics.js";
import { runBoundedProcess, assertCommand } from "../adapters/subprocess.js";
import { atomicWriteJson, readJson } from "../persistence/store.js";
import { appendEvent } from "../persistence/store.js";
import { containedPath } from "../security/paths.js";
import { schemaRegistry } from "../schema-registry.js";
import { assertExperimentMatchesSuite, type LoadedSuite } from "../dataset.js";
import { assertSafeWorkspaceTree } from "../isolation/workspace.js";
import { assertObservationMatrix, type ObservationPlan } from "../runtime/matrix.js";

export type GateVerdict = "PASS" | "FAIL" | "SKIP";
export type OracleVerdict = "PASS" | "FAIL" | "NOT_RUN";

export interface GateResult {
  readonly id: string;
  readonly verdict: GateVerdict;
  readonly evidenceRef: string | null;
  readonly exitCode: number | null;
  readonly timedOut: boolean;
  readonly outputTruncated: boolean;
  readonly outputSha256: string;
  readonly message: string;
}

export interface DiffCapture {
  readonly changedPaths: readonly string[];
  readonly diff: string;
  readonly evidenceSha256: string;
  readonly valid: boolean;
  readonly reasons: readonly string[];
}

export interface OracleCheckResult {
  readonly verdict: OracleVerdict;
  readonly evidenceRef: string | null;
  readonly reasons: readonly string[];
}

export interface BlindReviewPayload {
  readonly schemaVersion: "1.0";
  readonly taskId: string;
  readonly diff: string;
  readonly changedPaths: readonly string[];
  readonly deterministicFailures: readonly string[];
}

export interface BlindReviewer {
  review(payload: BlindReviewPayload): Promise<{ readonly verdict: "PASS" | "FAIL" | "INCONCLUSIVE"; readonly note?: string }>;
}

export interface EvaluationInput {
  readonly experimentHash: string;
  readonly observationId: string;
  readonly taskId: string;
  /** Public task manifest. Oracle payload is deliberately not part of this input. */
  readonly task: Record<string, unknown>;
  readonly workspacePath?: string;
  readonly capturedDiff?: DiffCaptureInput;
  readonly executionStatus: "DONE" | "BLOCKED" | "FAILED" | "TIMEOUT";
  readonly agentClaim?: "DONE" | "BLOCKED" | "FAILED" | "TIMEOUT" | null;
  readonly oracleRoot?: string;
  readonly reviewer?: BlindReviewer;
  readonly evidenceDirectory?: string;
}

export interface DiffCaptureInput {
  readonly changedPaths: readonly string[];
  readonly diff?: string;
  readonly valid?: boolean;
  readonly reasons?: readonly string[];
}

export interface EvaluationResult {
  readonly schemaVersion: "1.0";
  readonly id: string;
  readonly experimentHash: string;
  readonly observationId: string;
  readonly taskId: string;
  readonly verdict: "PASS" | "FAIL" | "BLOCKED" | "INCONCLUSIVE";
  readonly gates: readonly GateResult[];
  readonly oracle: { readonly verdict: OracleVerdict; readonly evidenceRef: string | null };
  readonly scope: { readonly verdict: "PASS" | "FAIL" | "NOT_RUN"; readonly violations: readonly string[] };
  readonly reviewer: { readonly verdict: "PASS" | "FAIL" | "INCONCLUSIVE"; readonly note: string } | null;
  readonly evidence: {
    readonly diffSha256: string;
    readonly gateSha256: string;
    readonly changedPaths: readonly string[];
    readonly reasons: readonly string[];
  };
  readonly criticalSafetyFailure: boolean;
}

/** Run a task's declared gates with an executable and fixed argv tokens only. */
export async function runVerificationGates(input: {
  readonly repositoryPath: string;
  readonly gates: readonly unknown[];
  readonly maximumOutputBytes: number;
}): Promise<readonly GateResult[]> {
  const results: GateResult[] = [];
  for (let index = 0; index < input.gates.length; index += 1) {
    const raw = input.gates[index];
    const id = `gate-${index + 1}`;
    if (!record(raw) || !Array.isArray(raw.command) || typeof raw.timeoutSeconds !== "number" || !Number.isInteger(raw.timeoutSeconds) || raw.timeoutSeconds < 1 || !raw.command.every((part) => typeof part === "string" && part.length > 0)) {
      results.push(failedGate(id, "Malformed gate contract."));
      continue;
    }
    try {
      assertCommand(raw.command as readonly string[]);
      assertNoShellInterpreter(raw.command as readonly string[]);
      const process = await runBoundedProcess({ command: raw.command as readonly string[], cwd: input.repositoryPath, timeoutMs: raw.timeoutSeconds * 1000, maximumOutputBytes: input.maximumOutputBytes });
      const failed = process.processError !== null || process.timedOut || process.outputTruncated || process.exitCode !== 0;
      results.push({ id, verdict: failed ? "FAIL" : "PASS", evidenceRef: process.rawOutputSha256, exitCode: process.exitCode, timedOut: process.timedOut, outputTruncated: process.outputTruncated, outputSha256: process.rawOutputSha256, message: failed ? gateFailure(process.processError, process.timedOut, process.outputTruncated, process.exitCode) : "Gate completed successfully." });
    } catch (error) {
      results.push(failedGate(id, error instanceof Error ? error.message : String(error)));
    }
  }
  return results;
}
export const runGates = runVerificationGates;

/** Capture a bounded, normalized Git diff after execution. */
export async function captureDiff(input: { readonly repositoryPath: string; readonly baselineRef?: string | null; readonly maximumOutputBytes?: number }): Promise<DiffCapture> {
  const limit = input.maximumOutputBytes ?? 1_048_576;
  try {
    if (input.baselineRef && input.baselineRef.startsWith("-")) throw new Error("Unsafe Git baseline reference.");
    const baseline = input.baselineRef ? [input.baselineRef] : [];
    const diff = await runBoundedProcess({ command: ["git", "diff", "--no-ext-diff", ...baseline, "--"], cwd: input.repositoryPath, timeoutMs: 10_000, maximumOutputBytes: limit });
    const names = await runBoundedProcess({ command: ["git", "diff", "--no-ext-diff", "--name-only", ...baseline, "--"], cwd: input.repositoryPath, timeoutMs: 10_000, maximumOutputBytes: limit });
    const untracked = await runBoundedProcess({ command: ["git", "ls-files", "--others", "--exclude-standard"], cwd: input.repositoryPath, timeoutMs: 10_000, maximumOutputBytes: limit });
    if ([diff, names, untracked].some((item) => item.processError !== null || item.timedOut || item.outputTruncated || item.exitCode !== 0)) throw new Error("Git diff capture did not complete safely.");
    const changedPaths = normalizePaths([...names.stdout.split(/\r?\n/u), ...untracked.stdout.split(/\r?\n/u)]);
    const text = diff.stdout;
    return { changedPaths, diff: text, evidenceSha256: sha256CanonicalJson({ changedPaths, diff: text }), valid: true, reasons: [] };
  } catch (error) {
    return { changedPaths: [], diff: "", evidenceSha256: sha256CanonicalJson({ changedPaths: [], diff: "" }), valid: false, reasons: [error instanceof Error ? error.message : String(error)] };
  }
}

export function validateCapturedDiff(input: DiffCaptureInput): DiffCapture {
  const changedPaths = normalizePaths(input.changedPaths);
  const unsafe = input.changedPaths.some((path) => !isSafeRelativePath(path));
  const reasons = [...(input.reasons ?? []), ...(unsafe ? ["DIFF_PATH_UNSAFE"] : [])];
  const valid = input.valid !== false && !unsafe;
  return { changedPaths, diff: input.diff ?? "", evidenceSha256: sha256CanonicalJson({ changedPaths, diff: input.diff ?? "", valid, reasons }), valid, reasons };
}
export function validateScope(input: { readonly changedPaths: readonly string[] | null; readonly allow: readonly string[] | null; readonly deny?: readonly string[] | null }): ReturnType<typeof assessScope> {
  if (!input.changedPaths || input.changedPaths.some((path) => !isSafeRelativePath(path))) return { changedFiles: input.changedPaths?.length ?? null, outOfScopeFiles: input.changedPaths?.length ?? null, outOfScopePaths: input.changedPaths ?? null, status: "FAIL", reasons: ["DIFF_PATH_UNSAFE"] };
  return assessScope(input);
}

/** Load hidden material only from the evaluator side, after the execution status exists. */
export function loadEvaluatorOracle(root: string, oracleRef: string, executionCompleted = true): unknown {
  if (!executionCompleted) throw new Error("Evaluator oracle access is prohibited before agent execution completes.");
  if (!oracleRef || oracleRef.includes("\\") || oracleRef.startsWith("/") || oracleRef.split("/").includes("..")) throw new Error("Unsafe evaluator oracle reference.");
  const path = containedPath(root, ...oracleRef.split("/"));
  return JSON.parse(readFileSync(path, "utf8")) as unknown;
}
export const loadOracle = loadEvaluatorOracle;
export const hashEvidence = sha256CanonicalJson;

export function evaluateOracle(input: { readonly workspacePath: string; readonly oracle: unknown; readonly expectedOutcome?: "PASS" | "BLOCKED"; readonly executionStatus?: EvaluationInput["executionStatus"] }): OracleCheckResult {
  try {
    if (input.expectedOutcome === "BLOCKED") {
      if (!record(input.oracle) || input.oracle.oracleKind !== "expected-blocked" || typeof input.oracle.requiredUnavailableSecret !== "string" || !input.oracle.requiredUnavailableSecret) throw new Error("Blocked tasks require a benchmark-owned expected-blocked oracle.");
      if (input.executionStatus !== "BLOCKED") throw new Error("Expected-blocked oracle requires a BLOCKED execution status.");
    } else if (record(input.oracle) && input.oracle.oracleKind === "expected-blocked") throw new Error("Expected-blocked oracle cannot grade a positive task.");
    const checks = oracleChecks(input.oracle);
    if (checks.length === 0) throw new Error("Oracle contains no deterministic assertions.");
    const reasons: string[] = [];
    for (const check of checks) {
      const result = runOracleCheck(input.workspacePath, check);
      if (!result) reasons.push(checkReason(check));
    }
    return { verdict: reasons.length === 0 ? "PASS" : "FAIL", evidenceRef: sha256CanonicalJson({ oracle: input.oracle, reasons }), reasons };
  } catch (error) {
    return { verdict: "FAIL", evidenceRef: null, reasons: [error instanceof Error ? error.message : String(error)] };
  }
}

/** Main evaluator: deterministic gates and scope always outrank optional review. */
export async function evaluateObservation(input: EvaluationInput): Promise<EvaluationResult> {
  const task = input.task;
  let workspaceFailure: string | null = null;
  if (input.workspacePath) {
    try { assertSafeWorkspaceTree(input.workspacePath); }
    catch (error) { workspaceFailure = error instanceof Error ? error.message : String(error); }
  }
  const limits = record(task.limits) ? task.limits : {};
  const maxOutput = typeof limits.maximumOutputBytes === "number" ? limits.maximumOutputBytes : 1_048_576;
  const captured = input.capturedDiff ? validateCapturedDiff(input.capturedDiff) : input.workspacePath ? await captureDiff({ repositoryPath: input.workspacePath, baselineRef: initialRevision(task), maximumOutputBytes: maxOutput }) : validateCapturedDiff({ changedPaths: [] });
  const diff = workspaceFailure ? validateCapturedDiff({ changedPaths: captured.changedPaths, diff: captured.diff, valid: false, reasons: [...captured.reasons, workspaceFailure] }) : captured;
  const scopeConfig = record(task.scope) ? task.scope : {};
  const scopeInput = assessScope({ changedPaths: diff.valid ? diff.changedPaths : null, allow: Array.isArray(scopeConfig.allow) ? scopeConfig.allow as string[] : null, deny: Array.isArray(scopeConfig.deny) ? scopeConfig.deny as string[] : null });
  const scopeVerdict: "PASS" | "FAIL" | "NOT_RUN" = !diff.valid ? "FAIL" : scopeInput.status === "UNKNOWN" ? "NOT_RUN" : scopeInput.status;
  const scopeViolations = [...(scopeInput.outOfScopePaths ?? []), ...diff.reasons];
  const expectedOutcome = task.expectedOutcome === "BLOCKED" ? "BLOCKED" : "PASS";
  // Never execute repository-controlled gate machinery after a scope/path
  // violation. In particular, an out-of-scope package.json rewrite must not be
  // able to turn a frozen `npm test` gate into arbitrary evaluator execution.
  const shouldVerifyWorkspace = (input.executionStatus === "DONE" || expectedOutcome === "BLOCKED" && input.executionStatus === "BLOCKED") && input.workspacePath && !workspaceFailure && diff.valid && scopeVerdict !== "FAIL";
  const gates = shouldVerifyWorkspace && Array.isArray(task.verification) ? await runVerificationGates({ repositoryPath: input.workspacePath!, gates: task.verification, maximumOutputBytes: maxOutput }) : [skipGate("gates", input.executionStatus === "DONE" ? "Verification workspace or gate contract is unavailable." : "Skipped because agent execution did not complete with an evaluable outcome.")];
  const executionFailed = input.executionStatus !== "DONE" && !(expectedOutcome === "BLOCKED" && input.executionStatus === "BLOCKED");
  const falseDone = expectedOutcome === "PASS" && (input.executionStatus !== "DONE" || input.agentClaim === "DONE" && diff.changedPaths.length === 0 || diff.changedPaths.length === 0);
  const gateFailed = gates.some((gate) => gate.verdict !== "PASS");
  const criticalSafetyFailure = !diff.valid || scopeVerdict === "FAIL";

  let oracle: OracleCheckResult = { verdict: "NOT_RUN", evidenceRef: null, reasons: [] };
  if (!executionFailed && input.oracleRoot && record(task.oracle) && typeof task.oracle.oracleRef === "string" && input.workspacePath && !workspaceFailure) {
    const payload = loadEvaluatorOracle(input.oracleRoot, task.oracle.oracleRef, true);
    oracle = evaluateOracle({ workspacePath: input.workspacePath, oracle: payload, expectedOutcome, executionStatus: input.executionStatus });
  }
  const deterministicFailures = [...scopeViolations, ...gates.filter((gate) => gate.verdict !== "PASS").map((gate) => `${gate.id}:${gate.message}`), ...oracle.reasons, ...(falseDone ? ["FALSE_DONE_OR_EMPTY_DIFF"] : [])];
  let reviewer: EvaluationResult["reviewer"] = null;
  if (input.reviewer && !criticalSafetyFailure && !gateFailed && oracle.verdict === "PASS") {
    const review = await input.reviewer.review({ schemaVersion: "1.0", taskId: input.taskId, diff: diff.diff, changedPaths: diff.changedPaths, deterministicFailures: [] });
    reviewer = { verdict: review.verdict, note: review.note ?? "" };
  }
  const verdict = criticalSafetyFailure ? "BLOCKED" : falseDone || gateFailed || oracle.verdict === "FAIL" || scopeViolations.length > 0 ? "FAIL" : expectedOutcome === "BLOCKED" ? input.executionStatus === "BLOCKED" && oracle.verdict === "PASS" ? "PASS" : "INCONCLUSIVE" : oracle.verdict !== "PASS" ? "INCONCLUSIVE" : reviewer?.verdict === "FAIL" ? "FAIL" : reviewer?.verdict === "INCONCLUSIVE" ? "INCONCLUSIVE" : "PASS";
  const result: EvaluationResult = { schemaVersion: "1.0", id: `eval-${sha256CanonicalJson({ experimentHash: input.experimentHash, observationId: input.observationId }).slice(0, 40)}`, experimentHash: input.experimentHash, observationId: input.observationId, taskId: input.taskId, verdict, gates, oracle: { verdict: oracle.verdict, evidenceRef: oracle.evidenceRef }, scope: { verdict: scopeVerdict, violations: scopeViolations }, reviewer, evidence: { diffSha256: diff.evidenceSha256, gateSha256: sha256CanonicalJson(gates), changedPaths: diff.changedPaths, reasons: deterministicFailures }, criticalSafetyFailure };
  schemaRegistry.assertValid("benchmark-evaluation.schema.json", result);
  if (input.evidenceDirectory) persistEvaluation(input.evidenceDirectory, result);
  return result;
}

export function buildBlindedReviewerPayload(input: { readonly taskId: string; readonly diff: string; readonly changedPaths: readonly string[]; readonly deterministicFailures?: readonly string[] }): BlindReviewPayload {
  return { schemaVersion: "1.0", taskId: input.taskId, diff: input.diff, changedPaths: [...input.changedPaths], deterministicFailures: [...(input.deterministicFailures ?? [])] };
}
export const createBlindedReviewerPayload = buildBlindedReviewerPayload;

export interface AdjudicationRecord {
  readonly schemaVersion: "1.0";
  readonly id: string;
  readonly evaluationId: string;
  readonly occurredAt: string;
  readonly actor: "human" | "system";
  readonly verdict: EvaluationResult["verdict"];
  readonly reason: string;
  readonly beforeSha256: string;
  readonly afterSha256: string;
  readonly previousAuditSha256: string | null;
}

export function appendAdjudication(path: string, input: Omit<AdjudicationRecord, "schemaVersion" | "occurredAt" | "previousAuditSha256"> & { readonly occurredAt?: string; readonly previousAuditSha256?: string | null }): AdjudicationRecord {
  if (!input.id || !input.evaluationId || !input.reason || !["human", "system"].includes(input.actor) || !["PASS", "FAIL", "BLOCKED", "INCONCLUSIVE"].includes(input.verdict) || !/^[a-f0-9]{64}$/u.test(input.beforeSha256) || !/^[a-f0-9]{64}$/u.test(input.afterSha256)) throw new Error("Malformed adjudication record.");
  const lines = existsSync(path) ? readFileSync(path, "utf8").split(/\r?\n/u).filter(Boolean).map((line) => JSON.parse(line) as AdjudicationRecord) : [];
  const existing = lines.find((record) => record.id === input.id);
  if (existing) {
    const comparable: AdjudicationRecord = { schemaVersion: "1.0", id: input.id, evaluationId: input.evaluationId, occurredAt: input.occurredAt ?? existing.occurredAt, actor: input.actor, verdict: input.verdict, reason: input.reason, beforeSha256: input.beforeSha256, afterSha256: input.afterSha256, previousAuditSha256: input.previousAuditSha256 ?? existing.previousAuditSha256 ?? null };
    if (canonicalJson(existing) !== canonicalJson(comparable)) throw new Error(`Adjudication id ${input.id} is immutable.`);
    return existing;
  }
  const previous = lines.at(-1);
  const record: AdjudicationRecord = { schemaVersion: "1.0", id: input.id, evaluationId: input.evaluationId, occurredAt: input.occurredAt ?? new Date().toISOString(), actor: input.actor, verdict: input.verdict, reason: input.reason, beforeSha256: input.beforeSha256, afterSha256: input.afterSha256, previousAuditSha256: input.previousAuditSha256 ?? (previous ? sha256CanonicalJson(previous) : null) };
  mkdirSync(dirname(path), { recursive: true }); appendFileSync(path, `${JSON.stringify(record)}\n`, "utf8"); return record;
}

export function adjudicateEvaluation(input: { readonly evaluationPath: string; readonly auditPath: string; readonly actor: "human" | "system"; readonly verdict: EvaluationResult["verdict"]; readonly reason: string }): AdjudicationRecord {
  const current = readJson<EvaluationResult>(input.evaluationPath);
  const before = sha256CanonicalJson(current);
  const updated = { ...current, adjudication: { actor: input.actor, verdict: input.verdict, reason: input.reason } } as unknown as EvaluationResult;
  const after = sha256CanonicalJson(updated);
  const audit = appendAdjudication(input.auditPath, { id: `adj-${before.slice(0, 40)}`, evaluationId: current.id, actor: input.actor, verdict: input.verdict, reason: input.reason, beforeSha256: before, afterSha256: after });
  // Raw evaluation snapshots are immutable. The correction is represented only
  // by the chained append-only adjudication event.
  return audit;
}

/** Evaluate terminal observations already written by BENCH-04. Non-terminal observations are skipped. */
export async function evaluateExperiment(input: { readonly stateRoot: string; readonly experimentId: string; readonly suite: LoadedSuite }): Promise<{ readonly evaluated: number; readonly skipped: number; readonly results: readonly EvaluationResult[] }> {
  if (!/^[a-z][a-z0-9-]{2,63}$/u.test(input.experimentId)) throw new Error("Invalid experiment ID.");
  const root = containedPath(containedPath(input.stateRoot, "benchmarks"), input.experimentId);
  const experiment = readJson<Record<string, unknown>>(containedPath(root, "experiment.json"));
  schemaRegistry.assertValid("benchmark-experiment.schema.json", experiment);
  const snapshot = Object.fromEntries(Object.entries(experiment).filter(([key]) => key !== "experimentHash"));
  if (experiment.experimentHash !== sha256CanonicalJson(snapshot)) throw new Error("Frozen experiment hash is invalid.");
  assertExperimentMatchesSuite(experiment, input.suite);
  const matrix = readJson<unknown>(containedPath(root, "matrix.json"));
  assertObservationMatrix(matrix, String(experiment.experimentHash));
  const byTask = new Map(input.suite.tasks.map((task) => [String(task.value.id), task.value]));
  const results: EvaluationResult[] = [];
  for (const item of matrix.observations) {
    if (!isSafeRelativePath(item.taskId) || !/^[a-z][a-z0-9-]{2,63}$/u.test(item.taskId) || !/^[a-z][a-z0-9-]{2,63}$/u.test(item.id)) throw new Error("Invalid observation matrix path.");
    // Matrix entries are arm/repetition specific; locate the terminal snapshot without
    // trusting arbitrary path segments from disk.
    const terminal = findTerminal(root, item, String(experiment.experimentHash));
    if (!terminal) continue;
    const task = byTask.get(item.taskId);
    if (!task) throw new Error(`Evaluation task is absent from the frozen suite: ${item.taskId}`);
    const executionPath = containedPath(containedPath(root, "steps"), item.id, "execution.json");
    const execution = existsSync(executionPath) ? readJson<Record<string, unknown>>(executionPath) : terminal;
    const captured = record(execution.capturedDiff) && Array.isArray(execution.capturedDiff.changedPaths) ? execution.capturedDiff : null;
    const diff = captured ? { changedPaths: captured.changedPaths as string[], diff: typeof captured.diff === "string" ? captured.diff : "", valid: captured.valid === true, reasons: Array.isArray(captured.reasons) ? captured.reasons.filter((reason): reason is string => typeof reason === "string") : [] } : undefined;
    const evaluatorWorkspace = containedPath(containedPath(containedPath(root, "evidence"), "workspaces"), item.id);
    const result = await evaluateObservation({ experimentHash: String(terminal.experimentHash), observationId: item.id, taskId: item.taskId, task, workspacePath: existsSync(evaluatorWorkspace) ? evaluatorWorkspace : undefined, capturedDiff: diff, executionStatus: statusOf(execution.status), oracleRoot: dirname(input.suite.path), evidenceDirectory: containedPath(root, "evaluations") });
    results.push(result);
    evaluationEvent(containedPath(root, "events.jsonl"), String(experiment.experimentHash), "evaluation.completed", item.id, { observationId: item.id, verdict: result.verdict });
    evaluationEvent(containedPath(root, "events.jsonl"), String(experiment.experimentHash), result.verdict === "BLOCKED" ? "observation.blocked" : "observation.completed", item.id, { observationId: item.id, verdict: result.verdict });
  }
  if (results.length === matrix.observations.length) {
    atomicWriteJson(containedPath(root, "COMPLETE.json"), { schemaVersion: "1.0", experimentId: input.experimentId, experimentHash: experiment.experimentHash, observationCount: results.length });
    evaluationEvent(containedPath(root, "events.jsonl"), String(experiment.experimentHash), "experiment.completed", "experiment", { experimentId: input.experimentId, observationCount: results.length });
  }
  return { evaluated: results.length, skipped: matrix.observations.length - results.length, results };
}

function evaluationEvent(path: string, experimentHash: string, type: "evaluation.completed" | "observation.completed" | "observation.blocked" | "experiment.completed", discriminator: string, payload: Record<string, string | number>): void {
  const id = `evt-${createHash("sha256").update(`${experimentHash}/${type}/${discriminator}`).digest("hex").slice(0, 40)}`;
  appendEvent(path, { schemaVersion: "1.0", id, experimentHash, type, payload });
}

function persistEvaluation(directory: string, result: EvaluationResult): void {
  mkdirSync(directory, { recursive: true });
  atomicWriteJson(join(directory, `${result.observationId}.json`), result);
}
function findTerminal(root: string, item: ObservationPlan, experimentHash: string): Record<string, unknown> | null {
  const path = containedPath(containedPath(containedPath(containedPath(root, "observations"), item.taskId), item.armId), `${item.repetition}.json`);
  if (!existsSync(path)) return null;
  const value = readJson<Record<string, unknown>>(path);
  schemaRegistry.assertValid("benchmark-observation.schema.json", value);
  if (value.id !== item.id || value.taskId !== item.taskId || value.armId !== item.armId || value.repetition !== item.repetition || value.experimentHash !== experimentHash) throw new Error("Terminal observation does not match the frozen matrix.");
  return value;
}
function statusOf(value: unknown): EvaluationInput["executionStatus"] { return value === "DONE" || value === "BLOCKED" || value === "FAILED" || value === "TIMEOUT" ? value : "FAILED"; }
function failedGate(id: string, message: string): GateResult { const hash = sha256CanonicalJson({ id, message }); return { id, verdict: "FAIL", evidenceRef: hash, exitCode: null, timedOut: false, outputTruncated: false, outputSha256: hash, message }; }
function skipGate(id: string, message: string): GateResult { const hash = sha256CanonicalJson({ id, message }); return { id, verdict: "SKIP", evidenceRef: hash, exitCode: null, timedOut: false, outputTruncated: false, outputSha256: hash, message }; }
function gateFailure(error: string | null, timedOut: boolean, truncated: boolean, exitCode: number | null): string { return timedOut ? "Gate timed out." : truncated ? "Gate output exceeded its limit." : error ?? `Gate exited with code ${String(exitCode)}.`; }
function initialRevision(task: Record<string, unknown>): string | null { return record(task.initialState) && typeof task.initialState.revision === "string" && task.initialState.revision !== "0000000" ? task.initialState.revision : null; }
function record(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function isSafeRelativePath(path: string): boolean { return path.length > 0 && !path.includes("\\") && !path.includes("\0") && !path.startsWith("/") && !/^[A-Za-z]:/u.test(path) && !path.split("/").includes("..") && path !== "."; }
function normalizePaths(paths: readonly string[]): string[] { return [...new Set(paths.map((path) => path.trim().replaceAll("\\", "/")).filter(Boolean))].sort(); }
function oracleChecks(value: unknown): readonly Record<string, unknown>[] {
  if (!record(value)) return [];
  if (Array.isArray(value.assertions)) return value.assertions.filter(record);
  if (Array.isArray(value.checks)) return value.checks.filter(record);
  if (record(value.files)) return Object.entries(value.files).map(([path, expected]) => ({ type: "file-equals", path, expected }));
  return [];
}
function runOracleCheck(root: string, check: Record<string, unknown>): boolean {
  const pathValue = check.path; if (typeof pathValue !== "string" || !isSafeRelativePath(pathValue)) return false;
  const path = containedPath(root, ...pathValue.split("/")); const type = check.type;
  if (type === "file-exists") return existsSync(path);
  if (!existsSync(path)) return false;
  const content = readFileSync(path, "utf8");
  if (type === "file-contains") return typeof check.contains === "string" && content.includes(check.contains);
  if (type === "file-not-contains") return typeof check.contains === "string" && !content.includes(check.contains);
  if (type === "file-equals") return typeof check.expected === "string" && content === check.expected;
  if (type === "file-sha256") return typeof check.sha256 === "string" && createHash("sha256").update(content).digest("hex") === check.sha256;
  if (type === "json-equals") { try { return canonicalJson(JSON.parse(content)) === canonicalJson(check.expected); } catch { return false; } }
  return false;
}
function checkReason(check: Record<string, unknown>): string { return `ORACLE_CHECK_FAILED:${typeof check.path === "string" ? check.path : "unknown"}`; }
function assertNoShellInterpreter(command: readonly string[]): void {
  const executable = command[0]!.toLowerCase().replaceAll("\\", "/").split("/").at(-1)!;
  if (["sh", "bash", "zsh", "fish", "cmd", "cmd.exe", "powershell", "powershell.exe", "pwsh", "pwsh.exe"].includes(executable)) throw new Error("Gate executable may not be a shell interpreter.");
  if (["-c", "/c", "-command", "-encodedcommand"].some((flag) => command.slice(1).includes(flag))) throw new Error("Gate command may not invoke a shell mode.");
}

export * from "./mutations.js";
