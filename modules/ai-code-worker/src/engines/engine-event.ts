import { sha256 } from "../manifest/normalize.js";
import { SchemaRegistry } from "../schema/json-schema.js";

export type EngineEventType =
  | "execution.started"
  | "session.bound"
  | "progress"
  | "command.started"
  | "command.finished"
  | "file.changed"
  | "usage.reported"
  | "heartbeat"
  | "warning"
  | "execution.completed"
  | "execution.failed"
  | "execution.cancelled";

export interface EngineEvent {
  readonly schemaVersion: "1.0";
  readonly executionId: string;
  readonly sequence: number;
  readonly createdAt: string;
  readonly type: EngineEventType;
  readonly sessionId: string | null;
  readonly payload: Record<string, unknown>;
  readonly rawPayloadSha256: string | null;
}

export interface EngineUsage {
  readonly inputUncachedTokens: number | null;
  readonly cacheReadTokens: number | null;
  readonly cacheWriteTokens: number | null;
  readonly outputTokens: number | null;
  readonly costUsd: number | null;
}

export interface EngineEventFactory {
  readonly executionId: string;
  readonly startedAt: string;
  readonly registry?: SchemaRegistry;
}

export class EngineEventStreamError extends Error {
  constructor(
    readonly code: "ENGINE_EVENT_SEQUENCE_GAP" | "ENGINE_EVENT_DUPLICATE" | "ENGINE_EVENT_SCHEMA_INVALID",
    message: string
  ) {
    super(message);
    this.name = "EngineEventStreamError";
  }
}

export function createEngineEvent(
  input: EngineEventFactory & {
    readonly sequence: number;
    readonly type: EngineEventType;
    readonly sessionId?: string | null;
    readonly payload?: Record<string, unknown>;
  }
): EngineEvent {
  const payload = input.payload ?? {};
  const event: EngineEvent = {
    schemaVersion: "1.0",
    executionId: input.executionId,
    sequence: input.sequence,
    createdAt: timestampAtSequence(input.startedAt, input.sequence),
    type: input.type,
    sessionId: input.sessionId ?? null,
    payload,
    rawPayloadSha256: Object.keys(payload).length > 0 ? sha256(JSON.stringify(payload)) : null
  };

  (input.registry ?? SchemaRegistry.load()).assertValid("engine-event.schema.json", event);

  return event;
}

export function validateEngineEventStream(events: readonly EngineEvent[]): void {
  const seen = new Set<number>();

  for (let index = 0; index < events.length; index += 1) {
    const event = events[index];

    if (seen.has(event.sequence)) {
      throw new EngineEventStreamError("ENGINE_EVENT_DUPLICATE", `Duplicate engine event sequence ${event.sequence}`);
    }

    if (event.sequence !== index) {
      throw new EngineEventStreamError(
        "ENGINE_EVENT_SEQUENCE_GAP",
        `Expected engine event sequence ${index}, got ${event.sequence}`
      );
    }

    seen.add(event.sequence);
  }
}

export function aggregateUsage(events: readonly EngineEvent[]): EngineUsage {
  const usageEvents = events.filter((event) => event.type === "usage.reported");
  const explicitModes = new Set(
    usageEvents
      .map((event) => event.payload.accountingMode)
      .filter((mode): mode is string => mode === "incremental" || mode === "cumulative")
  );
  if (explicitModes.size > 1) {
    return unknownUsage();
  }
  if (explicitModes.has("cumulative")) {
    const last = usageEvents.at(-1);
    return last ? usageFromPayload(last.payload) : unknownUsage();
  }

  let inputUncachedTokens: number | null = null;
  let cacheReadTokens: number | null = null;
  let cacheWriteTokens: number | null = null;
  let outputTokens: number | null = null;
  let costUsd: number | null = null;

  for (const event of events) {
    if (event.type !== "usage.reported") {
      continue;
    }

    inputUncachedTokens = addNullable(inputUncachedTokens, readNullableNumber(event.payload.inputUncachedTokens));
    cacheReadTokens = addNullable(cacheReadTokens, readNullableNumber(event.payload.cacheReadTokens));
    cacheWriteTokens = addNullable(cacheWriteTokens, readNullableNumber(event.payload.cacheWriteTokens));
    outputTokens = addNullable(outputTokens, readNullableNumber(event.payload.outputTokens));
    costUsd = addNullable(costUsd, readNullableNumber(event.payload.costUsd));
  }

  return {
    inputUncachedTokens,
    cacheReadTokens,
    cacheWriteTokens,
    outputTokens,
    costUsd
  };
}

function usageFromPayload(payload: Record<string, unknown>): EngineUsage {
  return {
    inputUncachedTokens: readNullableNumber(payload.inputUncachedTokens),
    cacheReadTokens: readNullableNumber(payload.cacheReadTokens),
    cacheWriteTokens: readNullableNumber(payload.cacheWriteTokens),
    outputTokens: readNullableNumber(payload.outputTokens),
    costUsd: readNullableNumber(payload.costUsd)
  };
}

function unknownUsage(): EngineUsage {
  return {
    inputUncachedTokens: null,
    cacheReadTokens: null,
    cacheWriteTokens: null,
    outputTokens: null,
    costUsd: null
  };
}

function addNullable(current: number | null, next: number | null): number | null {
  if (next === null) {
    return current;
  }

  return (current ?? 0) + next;
}

function readNullableNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function timestampAtSequence(startedAt: string, sequence: number): string {
  return new Date(Date.parse(startedAt) + sequence * 1000).toISOString();
}
