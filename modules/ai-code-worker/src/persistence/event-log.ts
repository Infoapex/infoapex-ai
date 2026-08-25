import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { SchemaRegistry } from "../schema/json-schema.js";

export type RunEventType =
  | "run.created"
  | "run.intent-created"
  | "manifest.compiled"
  | "manifest.frozen"
  | "authorization.bound"
  | "run.recovering"
  | "run.superseded"
  | "task.input-frozen"
  | "task.stale"
  | "task.worktree-created"
  | "run.wave-dispatched"
  | "task.started"
  | "task.committed"
  | "task.finished"
  | "gate.started"
  | "gate.finished"
  | "review.finished"
  | "review.finding-ingested"
  | "repair.budget-initialized"
  | "repair.task-compiled"
  | "repair.attempt-started"
  | "repair.attempt-finished"
  | "repair.cycle-exhausted"
  | "graph.revision-created"
  | "run.done"
  | "run.blocked";

export interface RunEvent {
  readonly schemaVersion: "1.0";
  readonly eventId: string;
  readonly runId: string;
  readonly sequence: number;
  readonly type: RunEventType;
  readonly createdAt: string;
  readonly payload: Record<string, unknown>;
}

export interface AppendRunEventInput {
  readonly eventId: string;
  readonly runId: string;
  readonly type: RunEventType;
  readonly createdAt: string;
  readonly payload?: Record<string, unknown>;
}

export interface AppendRunEventResult {
  readonly event: RunEvent;
  readonly path: string;
}

export interface EventLogReadResult {
  readonly events: readonly RunEvent[];
  readonly ignoredTailLines: readonly string[];
}

export class EventLogError extends Error {
  constructor(
    readonly code: "EVENT_SEQUENCE_MISMATCH" | "EVENT_RUN_MISMATCH" | "EVENT_LOG_CORRUPT",
    message: string
  ) {
    super(message);
    this.name = "EventLogError";
  }
}

export class EventLog {
  constructor(
    readonly path: string,
    private readonly registry = SchemaRegistry.load()
  ) {}

  append(input: AppendRunEventInput): AppendRunEventResult {
    const events = this.read().events;
    const sequence = events.length;
    const event: RunEvent = {
      schemaVersion: "1.0",
      eventId: input.eventId,
      runId: input.runId,
      sequence,
      type: input.type,
      createdAt: input.createdAt,
      payload: input.payload ?? {}
    };

    this.registry.assertValid("event.schema.json", event);
    ensureDirectory(dirname(this.path));
    writeFileSync(this.path, `${JSON.stringify(event)}\n`, { flag: "a", encoding: "utf8" });

    return { event, path: this.path };
  }

  read(): EventLogReadResult {
    if (!existsSync(this.path)) {
      return { events: [], ignoredTailLines: [] };
    }

    const content = readFileSync(this.path, "utf8");
    const lines = content.split(/\r?\n/);
    const events: RunEvent[] = [];
    const ignoredTailLines: string[] = [];

    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];

      if (!line) {
        continue;
      }

      let parsed: unknown;

      try {
        parsed = JSON.parse(line);
      } catch (error) {
        if (isLastNonEmptyLine(lines, index) && error instanceof SyntaxError) {
          ignoredTailLines.push(line);
          break;
        }

        throw new EventLogError(
          "EVENT_LOG_CORRUPT",
          error instanceof Error ? error.message : `Corrupt event log line ${index + 1}`
        );
      }

      try {
        const event = parsed as RunEvent;
        this.registry.assertValid("event.schema.json", event);
        assertEventSequence(events, event);
        events.push(event);
      } catch (error) {
        throw new EventLogError(
          "EVENT_LOG_CORRUPT",
          error instanceof Error ? error.message : `Corrupt event log line ${index + 1}`
        );
      }
    }

    return { events, ignoredTailLines };
  }
}

function assertEventSequence(events: readonly RunEvent[], event: RunEvent): void {
  const expectedSequence = events.length;

  if (event.sequence !== expectedSequence) {
    throw new EventLogError(
      "EVENT_SEQUENCE_MISMATCH",
      `Expected event sequence ${expectedSequence}, got ${event.sequence}`
    );
  }

  const firstRunId = events[0]?.runId;
  if (firstRunId && event.runId !== firstRunId) {
    throw new EventLogError("EVENT_RUN_MISMATCH", `Expected runId ${firstRunId}, got ${event.runId}`);
  }
}

function isLastNonEmptyLine(lines: readonly string[], index: number): boolean {
  return lines.slice(index + 1).every((line) => !line);
}

function ensureDirectory(path: string): void {
  mkdirSync(path, { recursive: true });
}
