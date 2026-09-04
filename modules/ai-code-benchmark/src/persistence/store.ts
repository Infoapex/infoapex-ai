import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, truncateSync, unlinkSync, writeSync, fsyncSync } from "node:fs";
import { dirname, join } from "node:path";
import { canonicalJson, sha256CanonicalJson } from "../canonical-json.js";
import { schemaRegistry } from "../schema-registry.js";

export type BenchmarkEventType = "experiment.frozen" | "experiment.started" | "observation.started" | "observation.prepared" | "observation.executed" | "observation.evaluation-ready" | "observation.cleanup-completed" | "observation.completed" | "observation.blocked" | "evaluation.completed" | "experiment.completed";

export interface BenchmarkEvent {
  readonly schemaVersion: "1.0";
  readonly id: string;
  readonly experimentHash: string;
  readonly occurredAt: string;
  readonly type: BenchmarkEventType;
  readonly sequence: number;
  readonly payload: Readonly<Record<string, string | number | boolean | null>>;
}

export function atomicWriteJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const body = `${JSON.stringify(value, null, 2)}\n`;
  if (existsSync(path)) {
    const current = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (canonicalJson(current) !== canonicalJson(value)) throw new Error(`Immutable snapshot already exists with different content: ${path}`);
    return;
  }
  const temporary = join(dirname(path), `.${sha256CanonicalJson({ path, body }).slice(0, 16)}.tmp`);
  if (existsSync(temporary)) unlinkSync(temporary); // A killed writer may leave only its private temp file.
  try {
    const descriptor = openSync(temporary, "wx");
    try { writeSync(descriptor, body, undefined, "utf8"); fsyncSync(descriptor); } finally { closeSync(descriptor); }
    renameSync(temporary, path);
  } catch (error) {
    if (existsSync(temporary)) unlinkSync(temporary);
    if (existsSync(path)) {
      const current = JSON.parse(readFileSync(path, "utf8")) as unknown;
      if (canonicalJson(current) === canonicalJson(value)) return;
    }
    throw error;
  }
}

export function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

export function readEvents(path: string): readonly BenchmarkEvent[] {
  if (!existsSync(path)) return [];
  const text = readFileSync(path, "utf8");
  const lines = text.split("\n");
  const events: BenchmarkEvent[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    if (line.length === 0) continue;
    let event: BenchmarkEvent;
    try {
      event = JSON.parse(line) as BenchmarkEvent;
    } catch (error) {
      const isTail = index === lines.length - 1 && !text.endsWith("\n");
      if (isTail) break;
      throw new Error(`Invalid event log JSON at line ${index + 1}: ${error instanceof Error ? error.message : String(error)}`);
    }
    try {
      schemaRegistry.assertValid("benchmark-event.schema.json", event);
      if (event.sequence !== events.length + 1) throw new Error(`event sequence ${event.sequence} is not contiguous`);
      if (events.some((entry) => entry.id === event.id)) throw new Error(`duplicate event id ${event.id}`);
      events.push(event);
    } catch (error) {
      throw new Error(`Invalid event log line ${index + 1}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return events;
}

export function appendEvent(path: string, input: Omit<BenchmarkEvent, "sequence" | "occurredAt">): BenchmarkEvent {
  mkdirSync(dirname(path), { recursive: true });
  repairTruncatedTail(path);
  const events = readEvents(path);
  const existing = events.find((event) => event.id === input.id);
  if (existing) {
    const comparable = { schemaVersion: existing.schemaVersion, id: existing.id, experimentHash: existing.experimentHash, type: existing.type, payload: existing.payload };
    if (canonicalJson(comparable) !== canonicalJson(input)) throw new Error(`Event id ${input.id} was already used with different content.`);
    return existing;
  }
  const event: BenchmarkEvent = { ...input, occurredAt: new Date().toISOString(), sequence: events.length + 1 };
  schemaRegistry.assertValid("benchmark-event.schema.json", event);
  const descriptor = openSync(path, "a");
  try { writeSync(descriptor, `${JSON.stringify(event)}\n`, undefined, "utf8"); fsyncSync(descriptor); } finally { closeSync(descriptor); }
  return event;
}

function repairTruncatedTail(path: string): void {
  if (!existsSync(path)) return;
  const text = readFileSync(path, "utf8");
  if (text.length === 0 || text.endsWith("\n")) return;
  const boundary = text.lastIndexOf("\n");
  const tail = text.slice(boundary + 1);
  let event: unknown;
  try {
    event = JSON.parse(tail) as unknown;
  } catch {
    truncateSync(path, Buffer.byteLength(boundary < 0 ? "" : text.slice(0, boundary + 1), "utf8"));
    return;
  }
  schemaRegistry.assertValid("benchmark-event.schema.json", event);
  const descriptor = openSync(path, "a");
  try { writeSync(descriptor, "\n", undefined, "utf8"); fsyncSync(descriptor); } finally { closeSync(descriptor); }
}
