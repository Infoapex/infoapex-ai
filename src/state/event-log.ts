import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createHash } from "node:crypto";
import { atomicWriteJson } from "./atomic-file.js";

export interface RecoveryEvent {
  readonly eventId: string;
  readonly runId: string;
  readonly type: string;
  readonly createdAt: string;
  readonly payload: Readonly<Record<string, unknown>>;
}

export interface EventLogSnapshot { readonly schemaVersion: "1.0"; readonly events: readonly RecoveryEvent[]; readonly sha256: string; }

/** An immutable, bounded event log.  The entire verified snapshot is atomically swapped
 * on append; duplicate event ids are a successful no-op rather than a second effect. */
export class EventLog {
  readonly path: string;
  readonly maximumEvents: number;

  constructor(path: string, options: { readonly maximumEvents?: number } = {}) {
    this.path = path;
    this.maximumEvents = options.maximumEvents ?? 512;
  }

  read(): EventLogSnapshot {
    if (!existsSync(this.path)) return snapshot([]);
    try {
      const parsed = JSON.parse(readFileSync(this.path, "utf8")) as { events?: unknown; sha256?: unknown };
      if (!Array.isArray(parsed.events) || !parsed.events.every(validEvent)) throw new Error("invalid event document");
      const events = parsed.events as RecoveryEvent[];
      const ids = new Set(events.map((event) => event.eventId));
      if (ids.size !== events.length || events.length > this.maximumEvents || (typeof parsed.sha256 === "string" && parsed.sha256 !== digest(events))) throw new Error("duplicate, tampered, or oversized event log");
      return snapshot(events);
    } catch {
      throw new EventLogError("EVENT_LOG_INVALID", "Recovery refuses an invalid or oversized event log.");
    }
  }

  append(event: RecoveryEvent): { readonly appended: boolean; readonly snapshot: EventLogSnapshot } {
    if (!validEvent(event)) throw new EventLogError("EVENT_INVALID", "Recovery event is malformed.");
    const current = this.read();
    if (current.events.some((candidate) => candidate.eventId === event.eventId)) return { appended: false, snapshot: current };
    if (current.events.length >= this.maximumEvents) throw new EventLogError("EVIDENCE_LIMIT", "Recovery evidence reached its bounded event limit.");
    const next = [...current.events, event];
    atomicWriteJson(this.path, { schemaVersion: "1.0", events: next, sha256: digest(next) });
    return { appended: true, snapshot: snapshot(next) };
  }

  evidencePath(): string { return join(dirname(this.path), "recovery-evidence.json"); }
}

export class EventLogError extends Error { constructor(readonly code: string, message: string) { super(message); } }
function validEvent(value: unknown): value is RecoveryEvent {
  if (!value || typeof value !== "object") return false;
  const event = value as Partial<RecoveryEvent>;
  return typeof event.eventId === "string" && event.eventId.length > 0 && event.eventId.length <= 200 &&
    typeof event.runId === "string" && event.runId.length > 0 && typeof event.type === "string" && event.type.length > 0 &&
    typeof event.createdAt === "string" && Number.isFinite(Date.parse(event.createdAt)) && !!event.payload && typeof event.payload === "object" && !Array.isArray(event.payload);
}
function digest(events: readonly RecoveryEvent[]): string { return createHash("sha256").update(JSON.stringify(events)).digest("hex"); }
function snapshot(events: readonly RecoveryEvent[]): EventLogSnapshot { return { schemaVersion: "1.0", events, sha256: digest(events) }; }
