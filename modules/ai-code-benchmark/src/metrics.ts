import { createHash } from "node:crypto";
import { appendFileSync, existsSync, readFileSync, mkdirSync } from "node:fs";
import { dirname, resolve, relative, sep } from "node:path";
import { execFileSync } from "node:child_process";
import type { AdapterUsage } from "./types.js";

/** BENCH-05 metric and parser contracts.  A parser version is part of every
 * parsed observation so that a future provider format cannot silently drift. */
export const METRICS_SCHEMA_VERSION = "1.0" as const;
export const CODEX_USAGE_PARSER_VERSION = "codex-jsonl.v1" as const;
export const CLAUDE_USAGE_PARSER_VERSION = "claude-result.v1" as const;
export const INFOAPEX_USAGE_PARSER_VERSION = "infoapex-root-envelope.v1" as const;

export type UsageMode = "cumulative" | "incremental";
export type CompletenessStatus = "COMPLETE" | "PARTIAL" | "UNKNOWN";

export interface ParsedUsage {
  readonly schemaVersion: typeof METRICS_SCHEMA_VERSION;
  readonly provider: "codex" | "claude" | "infoapex";
  readonly parserVersion: string;
  readonly valid: boolean;
  readonly mode: UsageMode;
  readonly executionKey: string | null;
  readonly sessionKey: string | null;
  readonly model: string | null;
  readonly latencyMs: number | null;
  readonly usage: AdapterUsage;
  readonly reasons: readonly string[];
}

export interface UsageSample {
  readonly provider: ParsedUsage["provider"];
  readonly parserVersion?: string;
  readonly mode?: UsageMode;
  readonly executionKey?: string | null;
  readonly sessionKey?: string | null;
  readonly sampleId?: string | null;
  readonly usage: Partial<AdapterUsage>;
}

export interface UsageIncrement {
  readonly usage: AdapterUsage;
  readonly duplicate: boolean;
  readonly key: string | null;
  readonly reasons: readonly string[];
}
export interface UsageAccumulatorState {
  readonly totals: Readonly<Record<string, AdapterUsage>>;
  readonly seen: Readonly<Record<string, readonly string[]>>;
}

export function unknownUsage(): AdapterUsage {
  return { inputUncachedTokens: null, cacheReadTokens: null, cacheWriteTokens: null, outputTokens: null, totalTokens: null, costUsd: null };
}

function numeric(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function text(value: unknown): string | null { return typeof value === "string" && value.length > 0 ? value : null; }
function record(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function json(value: string): unknown { try { return JSON.parse(value); } catch { return null; } }
function first<T>(...values: T[]): T | null { return values.find((value) => value !== null && value !== undefined) ?? null; }

export function normalizeUsage(source: Record<string, unknown>, envelope: Record<string, unknown> = source): AdapterUsage {
  const inputUncachedTokens = numeric(first(source.input_tokens, source.inputUncachedTokens));
  const cacheReadTokens = numeric(first(source.cache_read_input_tokens, source.cacheReadTokens, source.cached_input_tokens));
  const cacheWriteTokens = numeric(first(source.cache_creation_input_tokens, source.cacheWriteTokens, source.cache_write_input_tokens));
  const outputTokens = numeric(first(source.output_tokens, source.outputTokens));
  const explicitTotal = numeric(first(source.total_tokens, source.totalTokens));
  const totalTokens = explicitTotal ?? (inputUncachedTokens !== null && cacheReadTokens !== null && cacheWriteTokens !== null && outputTokens !== null
    ? inputUncachedTokens + cacheReadTokens + cacheWriteTokens + outputTokens : null);
  const costUsd = numeric(first(envelope.total_cost_usd, envelope.costUsd, source.total_cost_usd, source.costUsd));
  return { inputUncachedTokens, cacheReadTokens, cacheWriteTokens, outputTokens, totalTokens, costUsd };
}

function modeOf(source: Record<string, unknown>, fallback: UsageMode): UsageMode {
  if (source.cumulative === true || source.is_cumulative === true || source.usage_mode === "cumulative" || source.mode === "cumulative" || source.kind === "total") return "cumulative";
  if (source.incremental === true || source.usage_mode === "incremental" || source.mode === "incremental" || source.kind === "delta") return "incremental";
  return fallback;
}

function parsed(provider: ParsedUsage["provider"], parserVersion: string, input: Partial<ParsedUsage> & { usage?: AdapterUsage; valid?: boolean; reasons?: readonly string[] }): ParsedUsage {
  return {
    schemaVersion: METRICS_SCHEMA_VERSION, provider, parserVersion,
    valid: input.valid ?? true, mode: input.mode ?? "incremental",
    executionKey: input.executionKey ?? null, sessionKey: input.sessionKey ?? null,
    model: input.model ?? null, latencyMs: input.latencyMs ?? null,
    usage: input.usage ?? unknownUsage(), reasons: input.reasons ?? []
  };
}

/** Parse Codex JSONL token_count events. Codex totals are cumulative. */
export function parseCodexUsage(output: string): ParsedUsage {
  const values = output.split(/\r?\n/u).filter((line) => line.trim().length > 0).map(json).filter(record);
  if (values.length === 0) return parsed("codex", CODEX_USAGE_PARSER_VERSION, { valid: false, reasons: ["MALFORMED_JSON"] });
  const event = [...values].reverse().find((value) => record(value.usage) || (value.type === "event_msg" && record(value.payload))) ?? values.at(-1)!;
  const declaredVersion = text(event.usageSchemaVersion) ?? text(event.schemaVersion);
  if (declaredVersion !== null && declaredVersion !== METRICS_SCHEMA_VERSION) return parsed("codex", CODEX_USAGE_PARSER_VERSION, { valid: false, reasons: ["VERSION_DRIFT"] });
  const payload = record(event.payload) ? event.payload : event;
  const info = record(payload.info) ? payload.info : payload;
  const total = record(info.total_token_usage) ? info.total_token_usage : record(event.usage) ? event.usage : info;
  const hasUsage = ["input_tokens", "output_tokens", "total_tokens", "totalTokenUsage", "total_tokens"].some((key) => total[key] !== undefined);
  const reasons = hasUsage ? [] : ["USAGE_NOT_REPORTED"];
  const model = values.map((value) => text(value.model) ?? (record(value.item) ? text(value.item.model) : null)).find((value) => value !== null) ?? null;
  return parsed("codex", CODEX_USAGE_PARSER_VERSION, {
    valid: values.some((value) => typeof value.type === "string" || typeof value.event === "string" || record(value.usage)),
    mode: "cumulative", usage: normalizeUsage(total, event), model,
    executionKey: text(event.executionKey) ?? text(event.execution_id), sessionKey: text(event.sessionKey) ?? text(event.session_id),
    latencyMs: numeric(first(event.provider_latency_ms, event.providerLatencyMs, info.provider_latency_ms)), reasons
  });
}

/** Parse Claude result envelopes. Messages API usage is an incremental turn. */
export function parseClaudeUsage(output: string): ParsedUsage {
  const value = json(output);
  if (!record(value)) return parsed("claude", CLAUDE_USAGE_PARSER_VERSION, { valid: false, reasons: ["MALFORMED_JSON"] });
  const declaredVersion = text(value.usageSchemaVersion) ?? text(value.schemaVersion);
  if (declaredVersion !== null && declaredVersion !== METRICS_SCHEMA_VERSION) return parsed("claude", CLAUDE_USAGE_PARSER_VERSION, { valid: false, reasons: ["VERSION_DRIFT"] });
  const source = record(value.usage) ? value.usage : record(value.result) && record(value.result.usage) ? value.result.usage : {};
  const model = text(value.model) ?? (record(value.result) ? text(value.result.model) : null);
  const valid = typeof value.result === "string" || record(value.result) || record(value.usage);
  return parsed("claude", CLAUDE_USAGE_PARSER_VERSION, {
    valid, mode: modeOf(source, "incremental"), usage: normalizeUsage(source, value), model,
    executionKey: text(value.executionKey) ?? text(value.execution_id), sessionKey: text(value.sessionKey) ?? text(value.session_id),
    latencyMs: numeric(first(value.provider_latency_ms, value.providerLatencyMs, source.provider_latency_ms)),
    reasons: valid ? [] : ["MALFORMED_ENVELOPE"]
  });
}

/** Parse the public Infoapex worker envelope. Explicit usage mode is required
 * when a worker supplies totals; absent mode is treated as incremental. */
export function parseInfoapexUsage(output: string): ParsedUsage {
  const value = json(output);
  if (!record(value)) return parsed("infoapex", INFOAPEX_USAGE_PARSER_VERSION, { valid: false, reasons: ["MALFORMED_JSON"] });
  const declaredVersion = text(value.usageSchemaVersion) ?? text(value.schemaVersion);
  if (declaredVersion !== null && declaredVersion !== METRICS_SCHEMA_VERSION) return parsed("infoapex", INFOAPEX_USAGE_PARSER_VERSION, { valid: false, reasons: ["VERSION_DRIFT"] });
  const body = record(value.body) ? value.body : value;
  const source = record(body.usage) ? body.usage : record(value.usage) ? value.usage : {};
  const valid = typeof value.status === "string" || typeof body.status === "string" || record(body.usage);
  return parsed("infoapex", INFOAPEX_USAGE_PARSER_VERSION, {
    valid, mode: modeOf(source, "incremental"), usage: normalizeUsage(source, body),
    model: text(body.model) ?? text(value.model),
    executionKey: text(body.executionKey) ?? text(value.executionKey), sessionKey: text(body.sessionKey) ?? text(value.sessionKey),
    latencyMs: numeric(first(body.provider_latency_ms, body.providerLatencyMs, source.provider_latency_ms)),
    reasons: valid ? [] : ["MALFORMED_ENVELOPE"]
  });
}

/** Stateful cumulative-to-incremental conversion. The key deliberately uses
 * a stable session key when available, making retries and resume idempotent. */
export class UsageAccumulator {
  private readonly totals = new Map<string, AdapterUsage>();
  private readonly seen = new Map<string, Set<string>>();

  public constructor(state?: UsageAccumulatorState) {
    for (const [key, value] of Object.entries(state?.totals ?? {})) this.totals.set(key, { ...unknownUsage(), ...value });
    for (const [key, values] of Object.entries(state?.seen ?? {})) this.seen.set(key, new Set(values));
  }

  public add(sample: UsageSample): UsageIncrement {
    const key = sample.sessionKey ?? sample.executionKey ?? null;
    if (key === null) return { usage: this.asUsage(sample.usage), duplicate: false, key, reasons: ["MISSING_EXECUTION_KEY"] };
    // Cumulative snapshots can safely derive identity from their values (the
    // same snapshot on resume is a duplicate). Incremental events need an
    // explicit event/sample id; otherwise two identical turns are legitimate
    // separate events and receive a deterministic sequence identity.
    const ids = this.seen.get(key) ?? new Set<string>();
    const id = sample.sampleId ?? ((sample.mode ?? "incremental") === "cumulative"
      ? createHash("sha256").update(JSON.stringify({ mode: sample.mode, usage: sample.usage })).digest("hex")
      // An execution key identifies the one normalized incremental envelope
      // emitted for that invocation. Falling back to ids.size was not stable
      // across resume: replaying the same envelope allocated a new identity and
      // charged it twice.
      : sample.executionKey ?? createHash("sha256").update(JSON.stringify({ mode: sample.mode, usage: sample.usage })).digest("hex"));
    if (ids.has(id)) return { usage: zeroKnown(sample.usage), duplicate: true, key, reasons: ["DUPLICATE_SAMPLE"] };
    ids.add(id); this.seen.set(key, ids);
    const current = this.asUsage(sample.usage);
    const previous = this.totals.get(key) ?? unknownUsage();
    const cumulative = (sample.mode ?? "incremental") === "cumulative";
    const increment = cumulative ? this.delta(current, previous) : current;
    this.totals.set(key, cumulative ? current : this.sum(previous, current));
    return { usage: increment, duplicate: false, key, reasons: [] };
  }

  public reset(): void { this.totals.clear(); this.seen.clear(); }
  /** JSON-safe checkpoint for process restart/resume. */
  public snapshot(): UsageAccumulatorState {
    return { totals: Object.fromEntries(this.totals), seen: Object.fromEntries([...this.seen].map(([key, values]) => [key, [...values]])) };
  }
  public exportState(): UsageAccumulatorState { return this.snapshot(); }
  public restore(state: UsageAccumulatorState): void {
    this.reset();
    for (const [key, value] of Object.entries(state.totals)) this.totals.set(key, { ...unknownUsage(), ...value });
    for (const [key, values] of Object.entries(state.seen)) this.seen.set(key, new Set(values));
  }

  private asUsage(value: Partial<AdapterUsage>): AdapterUsage { return { ...unknownUsage(), ...value }; }
  private sum(a: AdapterUsage, b: AdapterUsage): AdapterUsage { return this.combine(a, b, (left, right) => left === null || right === null ? null : left + right); }
  private delta(current: AdapterUsage, previous: AdapterUsage): AdapterUsage {
    return this.combine(current, previous, (now, before) => now === null ? null : before === null ? now : now >= before ? now - before : now);
  }
  private combine(a: AdapterUsage, b: AdapterUsage, op: (a: number | null, b: number | null) => number | null): AdapterUsage {
    return { inputUncachedTokens: op(a.inputUncachedTokens, b.inputUncachedTokens), cacheReadTokens: op(a.cacheReadTokens, b.cacheReadTokens), cacheWriteTokens: op(a.cacheWriteTokens, b.cacheWriteTokens), outputTokens: op(a.outputTokens, b.outputTokens), totalTokens: op(a.totalTokens, b.totalTokens), costUsd: op(a.costUsd, b.costUsd) };
  }
}

function zeroKnown(value: Partial<AdapterUsage>): AdapterUsage {
  const zero = (candidate: number | null | undefined): number | null => candidate === null || candidate === undefined ? null : 0;
  return { inputUncachedTokens: zero(value.inputUncachedTokens), cacheReadTokens: zero(value.cacheReadTokens), cacheWriteTokens: zero(value.cacheWriteTokens), outputTokens: zero(value.outputTokens), totalTokens: zero(value.totalTokens), costUsd: zero(value.costUsd) };
}

export interface LatencySplit { readonly providerLatencyMs: number | null; readonly harnessLatencyMs: number | null; readonly totalLatencyMs: number | null; readonly reasons: readonly string[]; }
export function splitLatency(input: { readonly elapsedMs?: number | null; readonly totalLatencyMs?: number | null; readonly providerLatencyMs?: number | null; readonly harnessLatencyMs?: number | null }): LatencySplit {
  const total = numeric(input.totalLatencyMs ?? input.elapsedMs);
  const provider = numeric(input.providerLatencyMs);
  const explicitHarness = numeric(input.harnessLatencyMs);
  const harness = explicitHarness ?? (total !== null && provider !== null && total >= provider ? total - provider : null);
  const reasons = [...(provider === null ? ["PROVIDER_LATENCY_UNKNOWN"] : []), ...(harness === null ? ["HARNESS_LATENCY_UNKNOWN"] : [])];
  return { providerLatencyMs: provider, harnessLatencyMs: harness, totalLatencyMs: total, reasons };
}

export interface DiffMetrics { readonly changedFiles: number | null; readonly addedLines: number | null; readonly deletedLines: number | null; readonly diffBytes: number | null; readonly changedPaths: readonly string[] | null; readonly reasons: readonly string[]; }
export function collectDiffMetrics(input: { readonly repositoryPath: string; readonly baselineRef?: string | null; readonly changedPaths?: readonly string[] | null }): DiffMetrics {
  if (input.changedPaths) return diffFromPaths(input.changedPaths, input.repositoryPath);
  try {
    if (input.baselineRef?.startsWith("-")) throw new Error("Unsafe Git baseline reference.");
    const args = ["diff", "--numstat"]; if (input.baselineRef) args.push(input.baselineRef);
    const textOutput = execFileSync("git", args, { cwd: resolve(input.repositoryPath), encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    const paths: string[] = []; let added = 0; let deleted = 0;
    for (const line of textOutput.split(/\r?\n/u).filter(Boolean)) {
      const parts = line.split("\t"); if (parts.length < 3) continue;
      if (/^\d+$/u.test(parts[0]!)) added += Number(parts[0]);
      if (/^\d+$/u.test(parts[1]!)) deleted += Number(parts[1]); paths.push(parts.slice(2).join("\t"));
    }
    const diffArgs = ["diff"]; if (input.baselineRef) diffArgs.push(input.baselineRef);
    const fullDiff = execFileSync("git", diffArgs, { cwd: resolve(input.repositoryPath), encoding: "buffer", stdio: ["ignore", "pipe", "ignore"] });
    return { changedFiles: paths.length, addedLines: added, deletedLines: deleted, diffBytes: fullDiff.byteLength, changedPaths: paths, reasons: [] };
  } catch { return { changedFiles: null, addedLines: null, deletedLines: null, diffBytes: null, changedPaths: null, reasons: ["GIT_DIFF_UNAVAILABLE"] }; }
}

function diffFromPaths(paths: readonly string[], repositoryPath: string): DiffMetrics {
  const normalized = paths.map((path) => relative(resolve(repositoryPath), resolve(repositoryPath, path)).split(sep).join("/"));
  const unsafe = normalized.filter((path) => path.length === 0 || path.startsWith("../") || path === "..");
  if (unsafe.length > 0) return { changedFiles: paths.length, addedLines: null, deletedLines: null, diffBytes: null, changedPaths: paths, reasons: ["DIFF_PATH_UNSAFE"] };
  return { changedFiles: normalized.length, addedLines: null, deletedLines: null, diffBytes: null, changedPaths: normalized, reasons: [] };
}

export interface ScopeMetrics { readonly changedFiles: number | null; readonly outOfScopeFiles: number | null; readonly outOfScopePaths: readonly string[] | null; readonly status: "PASS" | "FAIL" | "UNKNOWN"; readonly reasons: readonly string[]; }
export function assessScope(input: { readonly changedPaths?: readonly string[] | null; readonly allow?: readonly string[] | null; readonly deny?: readonly string[] | null }): ScopeMetrics {
  if (!input.changedPaths || !input.allow) return { changedFiles: null, outOfScopeFiles: null, outOfScopePaths: null, status: "UNKNOWN", reasons: ["SCOPE_INPUT_UNKNOWN"] };
  const allow = input.allow.map(normalPath); const deny = (input.deny ?? []).map(normalPath);
  const out = input.changedPaths.map(normalPath).filter((path) => deny.some((item) => path === item || path.startsWith(`${item}/`)) || !allow.some((item) => item === path || item.endsWith("/") && path.startsWith(item) || path.startsWith(`${item}/`)));
  return { changedFiles: input.changedPaths.length, outOfScopeFiles: out.length, outOfScopePaths: out, status: out.length === 0 ? "PASS" : "FAIL", reasons: out.length === 0 ? [] : ["OUT_OF_SCOPE_CHANGES"] };
}
function normalPath(value: string): string { return value.replaceAll("\\", "/").replace(/^\.\//u, "").replace(/\/$/u, ""); }

export interface EvidenceMetrics { readonly expected: number | null; readonly present: number | null; readonly coverage: number | null; readonly traceExpected: number | null; readonly tracePresent: number | null; readonly traceCoverage: number | null; readonly reasons: readonly string[]; }
export function assessEvidence(input: { readonly expected?: number | null; readonly present?: number | null; readonly traceExpected?: number | null; readonly tracePresent?: number | null }): EvidenceMetrics {
  const expected = numeric(input.expected); const present = numeric(input.present); const traceExpected = numeric(input.traceExpected); const tracePresent = numeric(input.tracePresent);
  const coverage = expected !== null && present !== null && expected > 0 ? Math.min(1, present / expected) : expected === 0 && present !== null ? 1 : null;
  const traceCoverage = traceExpected !== null && tracePresent !== null && traceExpected > 0 ? Math.min(1, tracePresent / traceExpected) : traceExpected === 0 && tracePresent !== null ? 1 : null;
  return { expected, present, coverage, traceExpected, tracePresent, traceCoverage, reasons: [...(coverage === null ? ["EVIDENCE_COVERAGE_UNKNOWN"] : []), ...(traceCoverage === null ? ["TRACE_COVERAGE_UNKNOWN"] : [])] };
}

export interface MetricCompleteness { readonly status: CompletenessStatus; readonly reasons: readonly string[]; readonly known: readonly string[]; readonly unknown: readonly string[]; }
export function metricCompleteness(input: { readonly usage?: Partial<AdapterUsage> | null; readonly latency?: LatencySplit | null; readonly diff?: DiffMetrics | null; readonly scope?: ScopeMetrics | null; readonly evidence?: EvidenceMetrics | null }): MetricCompleteness {
  const unknown: string[] = []; const known: string[] = [];
  const check = (name: string, value: unknown): void => { if (value === null || value === undefined) unknown.push(name); else known.push(name); };
  if (input.usage) for (const key of ["inputUncachedTokens", "cacheReadTokens", "cacheWriteTokens", "outputTokens", "costUsd"] as const) check(`usage.${key}`, input.usage[key]); else unknown.push("usage");
  if (input.latency) { check("latency.provider", input.latency.providerLatencyMs); check("latency.harness", input.latency.harnessLatencyMs); } else unknown.push("latency");
  if (input.diff) { check("diff.changedFiles", input.diff.changedFiles); check("diff.addedLines", input.diff.addedLines); check("diff.deletedLines", input.diff.deletedLines); } else unknown.push("diff");
  if (input.scope) check("scope", input.scope.status === "UNKNOWN" ? null : input.scope.status); else unknown.push("scope");
  if (input.evidence) check("evidence.coverage", input.evidence.coverage); else unknown.push("evidence");
  return { status: unknown.length === 0 ? "COMPLETE" : known.length === 0 ? "UNKNOWN" : "PARTIAL", reasons: unknown, known, unknown };
}

export function aggregateCompleteness(items: readonly MetricCompleteness[]): MetricCompleteness {
  const unknown = [...new Set(items.flatMap((item) => item.unknown))]; const known = [...new Set(items.flatMap((item) => item.known))];
  return { status: unknown.length === 0 ? "COMPLETE" : known.length === 0 ? "UNKNOWN" : "PARTIAL", reasons: unknown, known, unknown };
}
export const assessCompleteness = metricCompleteness;

export interface ObservationMetricCapture {
  readonly schemaVersion: typeof METRICS_SCHEMA_VERSION;
  readonly latency: LatencySplit;
  readonly usage: AdapterUsage;
  readonly diff: DiffMetrics;
  readonly scope: ScopeMetrics;
  readonly evidence: EvidenceMetrics;
  readonly completeness: MetricCompleteness;
  readonly eligibleTraceCoverage?: number;
  readonly telemetryLeakageCount?: number;
}
export type ObservationMetricInput = { readonly elapsedMs?: number | null; readonly providerLatencyMs?: number | null; readonly harnessLatencyMs?: number | null; readonly usage?: Partial<AdapterUsage> | null; readonly diff?: DiffMetrics | null; readonly scope?: ScopeMetrics | null; readonly evidence?: EvidenceMetrics | null; readonly eligibleTraceCoverage?: number; readonly telemetryLeakageCount?: number };
export function captureObservationMetrics(input: ObservationMetricInput): ObservationMetricCapture {
  const latency = splitLatency(input); const usage = { ...unknownUsage(), ...(input.usage ?? {}) };
  const diff = input.diff ?? { changedFiles: null, addedLines: null, deletedLines: null, diffBytes: null, changedPaths: null, reasons: ["DIFF_NOT_CAPTURED"] };
  const scope = input.scope ?? { changedFiles: null, outOfScopeFiles: null, outOfScopePaths: null, status: "UNKNOWN" as const, reasons: ["SCOPE_NOT_CAPTURED"] };
  const evidence = input.evidence ?? assessEvidence({});
  return { schemaVersion: METRICS_SCHEMA_VERSION, latency, usage, diff, scope, evidence, completeness: metricCompleteness({ usage, latency, diff, scope, evidence }), ...(input.eligibleTraceCoverage === undefined ? {} : { eligibleTraceCoverage: input.eligibleTraceCoverage }), ...(input.telemetryLeakageCount === undefined ? {} : { telemetryLeakageCount: input.telemetryLeakageCount }) };
}
export const captureMetrics = captureObservationMetrics;
export const computeScopeMetrics = assessScope;
export const computeEvidenceMetrics = assessEvidence;

export interface Intervention {
  readonly schemaVersion: typeof METRICS_SCHEMA_VERSION;
  readonly id: string;
  readonly experimentHash: string;
  readonly observationId: string;
  readonly occurredAt: string;
  readonly kind: "setup" | "diagnosis" | "repair" | "review" | "adjudication";
  readonly actor: "human" | "system";
  readonly activeMinutes: number;
  readonly reason: string;
}
const idPattern = /^[a-z][a-z0-9-]{2,63}$/u;
const hashPattern = /^[a-f0-9]{64}$/u;
export function redactSecrets(value: string): string {
  return value.replace(/((?:authorization)\s*[:=]\s*)bearer\s+([^\s,;]+)/giu, "$1Bearer [REDACTED]")
    .replace(/((?:api[_-]?key|token|secret|password|authorization)\s*["']?\s*[:=]\s*["']?)(?!bearer\b)([^\s,;"']+)(["']?)/giu, "$1[REDACTED]$3")
    .replace(/\bbearer\s+[A-Za-z0-9._~-]{8,}/giu, "Bearer [REDACTED]")
    .replace(/\b(sk-[A-Za-z0-9_-]{8,}|gh[pousr]_[A-Za-z0-9_]{8,})\b/gu, "[REDACTED]");
}
export function validateIntervention(value: unknown): Intervention {
  const allowed = ["activeMinutes", "actor", "experimentHash", "id", "kind", "observationId", "occurredAt", "reason", "schemaVersion"];
  if (!record(value) || Object.keys(value).some((key) => !allowed.includes(key)) || value.schemaVersion !== METRICS_SCHEMA_VERSION || typeof value.id !== "string" || !idPattern.test(value.id) || typeof value.experimentHash !== "string" || !hashPattern.test(value.experimentHash) || typeof value.observationId !== "string" || !idPattern.test(value.observationId) || typeof value.occurredAt !== "string" || Number.isNaN(Date.parse(value.occurredAt)) || !["setup", "diagnosis", "repair", "review", "adjudication"].includes(value.kind as string) || !["human", "system"].includes(value.actor as string) || typeof value.activeMinutes !== "number" || !Number.isFinite(value.activeMinutes) || value.activeMinutes < 0 || typeof value.reason !== "string" || value.reason.trim().length === 0) throw new Error("Invalid BENCH-05 intervention record.");
  return { schemaVersion: METRICS_SCHEMA_VERSION, id: value.id, experimentHash: value.experimentHash, observationId: value.observationId, occurredAt: value.occurredAt, kind: value.kind as Intervention["kind"], actor: value.actor as Intervention["actor"], activeMinutes: value.activeMinutes, reason: redactSecrets(value.reason) };
}
export const validateManualIntervention = validateIntervention;
export function readInterventions(path: string): readonly Intervention[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8").split(/\r?\n/u).filter(Boolean).map((line) => validateIntervention(JSON.parse(line)));
}
export function appendIntervention(path: string, value: unknown): Intervention {
  const intervention = validateIntervention(value); const existing = readInterventions(path).find((item) => item.id === intervention.id);
  if (existing) { if (JSON.stringify(existing) !== JSON.stringify(intervention)) throw new Error(`Intervention id ${intervention.id} already exists with different content.`); return existing; }
  mkdirSync(dirname(path), { recursive: true }); appendFileSync(path, `${JSON.stringify(intervention)}\n`, "utf8"); return intervention;
}
export const appendInterventionLog = appendIntervention;
export function importInterventions(path: string, values: readonly unknown[] | string): readonly Intervention[] {
  const records = typeof values === "string" ? readFileSync(values, "utf8").split(/\r?\n/u).filter(Boolean).map((line) => JSON.parse(line)) : [...values];
  const validated = records.map(validateIntervention);
  const current = readInterventions(path); const byId = new Map(current.map((item) => [item.id, JSON.stringify(item)]));
  for (const item of validated) {
    const serialized = JSON.stringify(item); const prior = byId.get(item.id);
    if (prior !== undefined && prior !== serialized) throw new Error(`Intervention id ${item.id} already exists with different content.`);
    byId.set(item.id, serialized);
  }
  for (const item of validated) appendIntervention(path, item);
  return readInterventions(path);
}
export const importInterventionLog = importInterventions;

/** Apply the parser's declared accounting mode using a caller-owned,
 * checkpointable accumulator. */
export function toIncrement(parsedUsage: ParsedUsage, accumulator: UsageAccumulator, sampleId?: string | null): UsageIncrement {
  return accumulator.add({ provider: parsedUsage.provider, parserVersion: parsedUsage.parserVersion, mode: parsedUsage.mode, executionKey: parsedUsage.executionKey, sessionKey: parsedUsage.sessionKey, sampleId, usage: parsedUsage.usage });
}

// Friendly aliases used by callers that refer to the metric family rather than
// the provider-specific parser name.
export const parseCodexOutputUsage = parseCodexUsage;
export const parseClaudeOutputUsage = parseClaudeUsage;
export const parseInfoapexOutputUsage = parseInfoapexUsage;
