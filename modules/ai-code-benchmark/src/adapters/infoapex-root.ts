import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, relative, resolve, sep } from "node:path";
import type { AdapterDoctorReport, AdapterRequest, AdapterResult, BenchmarkAdapter, CandidateTelemetryEvidence } from "../types.js";
import { ADAPTER_VERSION, normalizedResult, probeCommand, unsupportedResult } from "./common.js";
import { INFOAPEX_PARSER_VERSION, parseInfoapexOutput } from "./parse.js";
import { redactSecrets } from "../metrics.js";
import { runBoundedProcess } from "./subprocess.js";
import { assertContained, canonicalPath, containedPath } from "../security/paths.js";

const REQUIRED = ["run", "--repo", "--plan", "--engine"] as const;
// The worker enforces the provider/task deadline itself.  The public root
// process needs a short additional window to terminate the provider tree,
// write its structured timeout finding and restore the isolated workspace.
// Without this margin both deadlines fire together and the benchmark sees an
// opaque adapter timeout instead of the actionable worker result.
export const INFOAPEX_ROOT_TEARDOWN_GRACE_MS = 15_000;

/** Invokes the bundle root CLI only. It reads public JSON configuration; it never imports worker/control code. */
export class InfoapexRootAdapter implements BenchmarkAdapter {
  public readonly id = "infoapex-root";
  public constructor(private readonly command: readonly string[]) {}
  public async doctor(): Promise<AdapterDoctorReport> { return probeCommand({ id: this.id, command: this.command, requiredCapabilities: REQUIRED, helpArgs: ["--help"] }); }
  public async execute(request: AdapterRequest): Promise<AdapterResult> {
    if (request.arm === "direct") return unsupportedResult({ id: this.id, parserVersion: INFOAPEX_PARSER_VERSION, request, executable: this.command[0], message: "infoapex-root does not implement the direct arm; no fallback was attempted." });
    const configuration = verifyPublicArmConfiguration(request);
    if (configuration !== null) return unsupportedResult({ id: this.id, parserVersion: INFOAPEX_PARSER_VERSION, request, executable: this.command[0], message: configuration });
    if (!request.orchestrationPlanPath) return unsupportedResult({ id: this.id, parserVersion: INFOAPEX_PARSER_VERSION, request, executable: this.command[0], message: "The Infoapex public root adapter requires an evaluator-produced orchestration plan path." });
    const planError = verifyEvaluatorPlan(request);
    if (planError !== null) return unsupportedResult({ id: this.id, parserVersion: INFOAPEX_PARSER_VERSION, request, executable: this.command[0], message: planError });
    const doctor = await this.doctor();
    if (doctor.status !== "PASS") return unsupportedResult({ id: this.id, parserVersion: INFOAPEX_PARSER_VERSION, request, executable: this.command[0], executableVersion: doctor.executableVersion, message: doctor.message });
    const process = await runBoundedProcess({
      // The public worker CLI only guarantees a machine-readable envelope when
      // `--json` is supplied. Without it a successful run prints human-oriented
      // progress lines, which the benchmark parser correctly rejects as malformed
      // output; a blocked run then collapses to the unhelpful generic exit-code
      // message. Keep the root→worker contract explicit and deterministic.
      command: [...this.command, "run", "--repo", request.repositoryPath, "--plan", request.orchestrationPlanPath, "--engine", request.provider, "--json"],
      cwd: request.repositoryPath,
      timeoutMs: request.limits.timeoutMs + INFOAPEX_ROOT_TEARDOWN_GRACE_MS,
      maximumOutputBytes: request.limits.maximumOutputBytes,
      environmentNames: request.environmentAllowlist
    });
    const normalized = normalizedResult({ id: this.id, parserVersion: INFOAPEX_PARSER_VERSION, request, executable: this.command[0]!, executableVersion: doctor.executableVersion, process, parsed: parseInfoapexOutput(process.stdout) });
    const failure = normalized.status !== "DONE" ? parseInfoapexFailure(process.stdout) : null;
    const diagnosed = failure === null ? normalized : { ...normalized, message: `Infoapex worker reported ${failure}.` };
    if (diagnosed.status !== "DONE") return diagnosed;

    const candidateTelemetry = collectCandidateTelemetry(process.stdout, request);
    const materialization = await materializeWorkerCommits(process.stdout, request);
    if (materialization.error !== null) return { ...normalized, status: "BLOCKED", message: materialization.error };
    return materialization.count === 0
      ? { ...normalized, ...(candidateTelemetry ? { candidateTelemetry } : {}) }
      : { ...normalized, message: `Adapter process completed and materialized ${materialization.count} worker commit(s) into the evaluator workspace.`, ...(candidateTelemetry ? { candidateTelemetry } : {}) };
  }
}

/** Extract only a bounded, redacted public finding from the root JSON envelope.
 * Raw stdout/stderr never crosses the adapter boundary. */
export function parseInfoapexFailure(output: string): string | null {
  let value: unknown;
  try { value = JSON.parse(output); } catch { return null; }
  if (!record(value)) return null;
  const body = record(value.body) ? value.body : value;
  const findings = Array.isArray(body.findings) ? body.findings : [];
  const finding = findings.find(record);
  if (!finding) return null;
  const code = typeof finding.code === "string" && /^[A-Z0-9_\-]{3,80}$/u.test(finding.code) ? finding.code : null;
  const rawMessage = typeof finding.message === "string" ? finding.message : null;
  if (code === null && rawMessage === null) return null;
  const safeMessage = rawMessage === null ? null : redactSecrets(rawMessage)
    .replace(/(?:[A-Za-z]:\\|\\\\|\/)(?:[^\s"']+\/)*[^\s"']+/gu, "[PATH_REDACTED]")
    .slice(0, 400);
  return [code, safeMessage].filter((part): part is string => part !== null && part.length > 0).join(": ");
}

const ALLOWED_SPAN_ATTRIBUTES = new Set([
  "taskId", "gateId", "runId", "commit", "parent", "exitCode", "failureClass", "outputSha256", "scope", "status", "code",
  "executionId", "sessionId", "intentId", "baseCommit", "planSha256", "manifestSha256", "authorizationId", "snapshotMetadataSha256",
  "contextDigest", "packageId", "headCommit", "branch", "maximumParallelWriters", "maximumRepairCycles", "repairTaskId", "cycle", "attempt",
  "outcome", "sourceMapDigest", "traceCoveragePercent", "complete", "coverageRows", "findings", "stopReason", "taskIds", "tasks", "changedPathCount"
]);
const SECRET_SHAPE = /(?:api[_-]?key|token|secret|password|authorization)\s*[=:]|\b(?:sk-|gh[pousr]_)[A-Za-z0-9_-]{8,}|\bbearer\s+[A-Za-z0-9._~-]{8,}/iu;
const ABSOLUTE_PATH = /(?:[A-Za-z]:\\Users\\|\/(?:home|Users)\/)[^\s"']+/u;
const PAIRS: Readonly<Record<string, { readonly finish: string; readonly fields: readonly string[] }>> = {
  "task.started": { finish: "task.finished", fields: ["taskId"] },
  "gate.started": { finish: "gate.finished", fields: ["taskId", "gateId"] },
  "repair.attempt-started": { finish: "repair.attempt-finished", fields: ["taskId", "attempt"] }
};

/** Read only aggregate, redaction-safe evidence from the worker state declared by
 * the isolated public config. Raw paths, events and spans are never returned. */
export function collectCandidateTelemetry(output: string, request: AdapterRequest): CandidateTelemetryEvidence | null {
  if (request.arm !== "full-icm" && request.arm !== "candidate") return null;
  try {
    const envelope = JSON.parse(output) as Record<string, unknown>;
    const body = record(envelope.body) ? envelope.body : envelope;
    const state = record(body.state) ? body.state : null;
    if (!state || typeof state.runRoot !== "string") return null;
    const config = JSON.parse(readFileSync(join(request.repositoryPath, ".ai-code-worker", "config.json"), "utf8")) as { stateRoot?: unknown };
    if (typeof config.stateRoot !== "string") return null;
    const configuredStateRoot = resolve(request.repositoryPath, config.stateRoot);
    const runRoot = trustedWorkerRunRoot(configuredStateRoot, state.runRoot);
    const eventPath = assertContained(runRoot, typeof state.eventLogPath === "string" ? state.eventLogPath : join(runRoot, "events.jsonl"));
    const eventText = readFileSync(eventPath, "utf8");
    const events = jsonLines(eventText);
    const expected = eligibleTraceUnits(events);
    const spanPath = join(runRoot, "otel-spans.jsonl");
    const spanText = existsSync(spanPath) ? readFileSync(assertContained(runRoot, spanPath), "utf8") : "";
    const spans = spanText ? jsonLines(spanText) : [];
    const leakageCount = spans.reduce((count, span) => count + spanLeakageCount(span), 0);
    return {
      eventCount: events.length,
      eligibleTraceUnits: expected,
      exportedSpans: spans.length,
      eligibleTraceCoverage: expected === 0 ? 1 : Math.min(1, spans.length / expected),
      telemetryLeakageCount: leakageCount,
      evidenceSha256: createHash("sha256").update(JSON.stringify({ eventSha256: hash(eventText), spanSha256: hash(spanText), expected, exported: spans.length, leakageCount })).digest("hex")
    };
  } catch {
    return null;
  }
}

function trustedWorkerRunRoot(configuredStateRoot: string, candidate: string): string {
  try { return assertContained(configuredStateRoot, candidate); } catch { /* worker compile currently uses its platform state root */ }
  const defaultBase = process.platform === "win32"
    ? process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local")
    : process.platform === "darwin"
      ? join(homedir(), "Library", "Application Support")
      : process.env.XDG_STATE_HOME ?? join(homedir(), ".local", "state");
  const repositoriesRoot = join(defaultBase, "ai-code-worker", "repos");
  const runRoot = assertContained(repositoriesRoot, candidate);
  const parts = relative(repositoriesRoot, runRoot).split(sep);
  if (parts.length !== 3 || !/^[a-f0-9]{16}$/u.test(parts[0] ?? "") || parts[1] !== "runs" || !/^[a-z][a-z0-9-]{2,63}$/u.test(parts[2] ?? "")) {
    throw new Error("Worker telemetry run root does not match the public state layout.");
  }
  return runRoot;
}

function jsonLines(value: string): Record<string, unknown>[] {
  return value.split(/\r?\n/u).filter(Boolean).map((line) => {
    const item: unknown = JSON.parse(line);
    if (!record(item)) throw new Error("Telemetry evidence contains a non-object JSON line.");
    return item;
  });
}

function eligibleTraceUnits(events: readonly Record<string, unknown>[]): number {
  const open = new Set<string>(); let units = 0;
  const finishes = new Map(Object.entries(PAIRS).map(([start, spec]) => [spec.finish, { start, fields: spec.fields }]));
  for (const event of events) {
    const type = typeof event.type === "string" ? event.type : ""; const payload = record(event.payload) ? event.payload : {};
    const start = PAIRS[type];
    if (start) { open.add(`${type}:${start.fields.map((field) => String(payload[field])).join(":")}`); continue; }
    const finish = finishes.get(type);
    if (finish) {
      const key = `${finish.start}:${finish.fields.map((field) => String(payload[field])).join(":")}`;
      if (open.delete(key)) units += 1; else units += 1;
      continue;
    }
    units += 1;
  }
  return units + open.size;
}

function spanLeakageCount(span: Record<string, unknown>): number {
  let count = 0; const attributes = record(span.attributes) ? span.attributes : {};
  for (const [key, value] of Object.entries(attributes)) {
    if (!ALLOWED_SPAN_ATTRIBUTES.has(key)) count += 1;
    const rendered = typeof value === "string" ? value : JSON.stringify(value);
    if (SECRET_SHAPE.test(rendered) || ABSOLUTE_PATH.test(rendered)) count += 1;
  }
  if (Array.isArray(span.events)) for (const event of span.events) if (record(event) && record(event.attributes)) {
    for (const [key, value] of Object.entries(event.attributes)) {
      if (!ALLOWED_SPAN_ATTRIBUTES.has(key)) count += 1;
      const rendered = typeof value === "string" ? value : JSON.stringify(value);
      if (SECRET_SHAPE.test(rendered) || ABSOLUTE_PATH.test(rendered)) count += 1;
    }
  }
  return count;
}

function hash(value: string): string { return createHash("sha256").update(value, "utf8").digest("hex"); }

async function materializeWorkerCommits(output: string, request: AdapterRequest): Promise<{ readonly count: number; readonly error: string | null }> {
  let value: unknown;
  try { value = JSON.parse(output); }
  catch { return { count: 0, error: null }; }
  if (!record(value)) return { count: 0, error: null };
  const body = record(value.body) ? value.body : value;
  if (!Object.prototype.hasOwnProperty.call(body, "taskCommits")) return { count: 0, error: null };
  if (!record(body.taskCommits) || !Array.isArray(body.executedTasks)) return { count: 0, error: "Infoapex reported task commits in an invalid public result envelope." };

  const commits: string[] = [];
  for (const taskId of body.executedTasks) {
    if (typeof taskId !== "string") return { count: 0, error: "Infoapex reported a non-string executed task identifier." };
    const commit = body.taskCommits[taskId];
    if (typeof commit !== "string" || !/^[a-f0-9]{40,64}$/u.test(commit)) return { count: 0, error: `Infoapex did not report a valid commit for executed task ${taskId}.` };
    commits.push(commit);
  }
  if (commits.length === 0) return { count: 0, error: null };

  const applied = await runBoundedProcess({
    command: ["git", "cherry-pick", "--no-commit", ...commits],
    cwd: request.repositoryPath,
    timeoutMs: Math.min(request.limits.timeoutMs, 15_000),
    maximumOutputBytes: Math.min(request.limits.maximumOutputBytes, 65_536)
  });
  if (applied.processError !== null || applied.timedOut || applied.outputTruncated || applied.exitCode !== 0) {
    return { count: 0, error: "Infoapex completed, but its worker commits could not be materialized safely in the evaluator workspace." };
  }
  return { count: commits.length, error: null };
}

function record(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }

function verifyEvaluatorPlan(request: AdapterRequest): string | null {
  try {
    const repository = canonicalPath(request.repositoryPath);
    const planPath = assertContained(repository, request.orchestrationPlanPath!);
    const markdown = readFileSync(planPath, "utf8");
    if (!/^---\r?\n[\s\S]*?\bstatus:\s*accepted\s*\r?\n[\s\S]*?---/u.test(markdown)) return "The evaluator-produced worker plan is not accepted Markdown.";
    const match = /```(?:json\s+)?ai-code-worker-plan\r?\n(?<json>[\s\S]*?)\r?\n```/u.exec(markdown);
    if (!match?.groups?.json) return "The evaluator-produced worker plan has no ai-code-worker-plan block.";
    const body = JSON.parse(match.groups.json) as { workerContractVersion?: unknown; goal?: unknown; tasks?: readonly { role?: unknown; acceptanceCriteria?: readonly unknown[]; traceability?: { acceptanceCriteria?: readonly { text?: unknown }[] } }[] };
    const task = body.tasks?.[0];
    if (body.workerContractVersion !== "1.1" || body.goal !== request.prompt || body.tasks?.length !== 1 || task?.role !== request.prompt || task.acceptanceCriteria?.[0] !== request.prompt || task.traceability?.acceptanceCriteria?.[0]?.text !== request.prompt) return "The worker v1.1 plan does not preserve the exact frozen generic task prompt and criteria.";
    return null;
  } catch {
    return "The evaluator-produced orchestration plan is invalid or outside the isolated repository.";
  }
}

function verifyPublicArmConfiguration(request: AdapterRequest): string | null {
  const declared = request.armConfiguration;
  if (!declared) return "Infoapex arms require an explicit public context configuration declaration.";
  if (request.arm === "orchestrated-no-icm" && (declared.contextProvider !== "none" || declared.contextPackageMode !== "off")) return "The orchestrated-no-icm arm must explicitly declare contextProvider none and contextPackage.mode off.";
  if ((request.arm === "full-icm" || request.arm === "candidate") && (declared.contextProvider !== "ai-code-control" || declared.contextPackageMode === "off")) return "The full-icm and candidate arms require ai-code-control and an enabled public context-package mode.";
  if (request.arm === "candidate" && (!declared.candidateCapability || declared.candidateCapability.trim().length === 0)) return "The candidate arm requires one declared candidate capability.";

  try {
    const repository = canonicalPath(request.repositoryPath);
    const configPath = containedPath(repository, ".ai-code-worker", "config.json");
    if (!existsSync(configPath)) return "The isolated repository does not contain the required public worker configuration.";
    const config = JSON.parse(readFileSync(configPath, "utf8")) as { contextProvider?: unknown; contextPackage?: { mode?: unknown } };
    const actualProvider = config.contextProvider;
    const actualMode = config.contextPackage?.mode;
    if (actualProvider !== declared.contextProvider || actualMode !== declared.contextPackageMode) return "The public worker configuration does not match the declared benchmark arm configuration.";
    return null;
  } catch {
    return "The public worker configuration is not valid JSON.";
  }
}

export const INFOAPEX_ROOT_ADAPTER_VERSION = ADAPTER_VERSION;
