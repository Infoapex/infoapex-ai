import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { EventLog, EventLogError, type RunEvent } from "../../src/persistence/event-log.js";
import { replayRun } from "../../src/persistence/replay.js";

const tempRoots: string[] = [];

after(() => {
  for (const root of tempRoots) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("event log and replay", () => {
  it("appends events with monotonic sequence and replays run state", () => {
    const log = eventLog();

    log.append({
      eventId: "event-1",
      runId: "run-1",
      type: "run.created",
      createdAt: "2026-08-01T10:00:00Z"
    });
    log.append({
      eventId: "event-2",
      runId: "run-1",
      type: "task.started",
      createdAt: "2026-08-01T10:01:00Z",
      payload: { taskId: "T1" }
    });
    log.append({
      eventId: "event-3",
      runId: "run-1",
      type: "run.done",
      createdAt: "2026-08-01T10:02:00Z"
    });

    const read = log.read();
    const replay = replayRun(read.events);

    assert.deepEqual(
      read.events.map((event) => event.sequence),
      [0, 1, 2]
    );
    assert.equal(read.ignoredTailLines.length, 0);
    assert.equal(replay.status, "DONE");
    assert.equal(replay.taskStates.T1, "STARTED");
    assert.equal(replay.lastSequence, 2);
  });

  it("ignores a truncated tail line but blocks internal corruption", () => {
    const log = eventLog();
    const first = event("event-1", 0);
    writeFileSync(log.path, `${JSON.stringify(first)}\n{"schemaVersion":`, "utf8");

    const read = log.read();
    assert.equal(read.events.length, 1);
    assert.equal(read.ignoredTailLines.length, 1);

    writeFileSync(log.path, `${JSON.stringify(first)}\nnot-json\n${JSON.stringify(event("event-2", 1))}\n`, "utf8");
    assert.throws(() => log.read(), (error) => error instanceof EventLogError && error.code === "EVENT_LOG_CORRUPT");
  });

  it("rejects non-monotonic sequence numbers", () => {
    const log = eventLog();
    writeFileSync(log.path, `${JSON.stringify(event("event-1", 0))}\n${JSON.stringify(event("event-2", 9))}\n`, "utf8");

    assert.throws(() => log.read(), (error) => error instanceof EventLogError && error.code === "EVENT_LOG_CORRUPT");
  });
});

function eventLog(): EventLog {
  const root = mkdtempSync(join(tmpdir(), "aicw-events-"));
  tempRoots.push(root);

  return new EventLog(join(root, "events.jsonl"));
}

function event(eventId: string, sequence: number): RunEvent {
  return {
    schemaVersion: "1.0",
    eventId,
    runId: "run-1",
    sequence,
    type: "run.created",
    createdAt: "2026-08-01T10:00:00Z",
    payload: {}
  };
}
