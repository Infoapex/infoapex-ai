import { existsSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

export type TelemetryEventType = "terminal" | "scope" | "leakage" | "recovery" | "latency" | "usage" | "human_intervention";
export interface RunTelemetryEvent {
  readonly schemaVersion: "1.0";
  readonly type: TelemetryEventType;
  readonly outcome: "PASS" | "BLOCKED" | "DONE" | "CANCELLED" | "RECOVERED" | "DETECTED";
  readonly occurredAt: string;
}

const EVENT_FILE = join(".infoapex-ai", "telemetry", "events.jsonl");
const MAX_EVENT_FILE_BYTES = 1024 * 1024;
const MAX_EVENTS = 10_000;

/** Drops every field except the compact SLO event contract; no transcript or usage payload survives. */
export function redactTelemetryEvent(input: unknown): RunTelemetryEvent | null {
  if (!isObject(input) || input.schemaVersion !== "1.0" || !isType(input.type) || !isOutcome(input.outcome) || typeof input.occurredAt !== "string" || !Number.isFinite(Date.parse(input.occurredAt))) return null;
  return { schemaVersion: "1.0", type: input.type, outcome: input.outcome, occurredAt: new Date(input.occurredAt).toISOString() };
}

/** Local-only aggregation. Export is deliberately absent from this contract and policy remains export-off. */
export function telemetrySummary(repositoryRoot: string): Record<string, unknown> {
  const path = join(resolve(repositoryRoot), EVENT_FILE);
  if (!existsSync(path)) return { schemaVersion: "1.0", status: "UNKNOWN", code: "TELEMETRY_NO_LOCAL_EVIDENCE", export: "off", events: 0, measures: emptyMeasures() };
  let size: number;
  try { size = statSync(path).size; } catch { return { schemaVersion: "1.0", status: "BLOCKED", code: "TELEMETRY_READ_FAILED", export: "off", events: 0, measures: emptyMeasures() }; }
  if (size > MAX_EVENT_FILE_BYTES) return { schemaVersion: "1.0", status: "BLOCKED", code: "TELEMETRY_SIZE_LIMIT", export: "off", events: 0, maximumBytes: MAX_EVENT_FILE_BYTES, measures: emptyMeasures() };
  const events: RunTelemetryEvent[] = [];
  try {
    for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
      if (line.trim() === "") continue;
      const event = redactTelemetryEvent(JSON.parse(line));
      if (!event || events.length >= MAX_EVENTS) return { schemaVersion: "1.0", status: "BLOCKED", code: "TELEMETRY_INVALID", export: "off", events: 0, measures: emptyMeasures() };
      events.push(event);
    }
  } catch { return { schemaVersion: "1.0", status: "BLOCKED", code: "TELEMETRY_INVALID", export: "off", events: 0, measures: emptyMeasures() }; }
  const measures = emptyMeasures();
  for (const event of events) {
    if (event.type === "terminal") { measures.terminalObserved += 1; if (["DONE", "BLOCKED", "CANCELLED"].includes(event.outcome)) measures.terminalExplicit += 1; }
    if (event.type === "scope" && event.outcome === "DETECTED") measures.scopeEscapes += 1;
    if (event.type === "leakage" && event.outcome === "DETECTED") measures.secretLeaks += 1;
    if (event.type === "recovery") { measures.recoveryAttempts += 1; if (event.outcome === "RECOVERED") measures.recoverySucceeded += 1; }
    if (event.type === "human_intervention") measures.humanInterventions += 1;
  }
  return { schemaVersion: "1.0", status: "PASS", code: "TELEMETRY_LOCAL_SUMMARY", export: "off", events: events.length, measures };
}

function emptyMeasures(): { terminalObserved: number; terminalExplicit: number; scopeEscapes: number; secretLeaks: number; recoveryAttempts: number; recoverySucceeded: number; humanInterventions: number } { return { terminalObserved: 0, terminalExplicit: 0, scopeEscapes: 0, secretLeaks: 0, recoveryAttempts: 0, recoverySucceeded: 0, humanInterventions: 0 }; }
function isObject(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value); }
function isType(value: unknown): value is TelemetryEventType { return value === "terminal" || value === "scope" || value === "leakage" || value === "recovery" || value === "latency" || value === "usage" || value === "human_intervention"; }
function isOutcome(value: unknown): value is RunTelemetryEvent["outcome"] { return value === "PASS" || value === "BLOCKED" || value === "DONE" || value === "CANCELLED" || value === "RECOVERED" || value === "DETECTED"; }
