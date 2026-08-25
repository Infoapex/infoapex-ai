import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { EngineEventStreamError, aggregateUsage, validateEngineEventStream } from "../../src/engines/engine-event.js";
import { FakeEngineAdapter } from "../../src/engines/fake-engine.js";
import { SchemaRegistry } from "../../src/schema/json-schema.js";

const registry = SchemaRegistry.load({ schemaDirectory: "schemas" });

describe("fake engine adapter", () => {
  it("emits deterministic normalized events and validates agent result", () => {
    const execution = new FakeEngineAdapter(registry).start({
      runId: "run-engine-1",
      taskId: "TASK-01",
      executionId: "exec-1",
      sessionId: "session-1",
      startedAt: "2026-08-01T10:00:00Z",
      touchedFiles: ["src/example.ts"],
      usage: {
        inputUncachedTokens: 10,
        cacheReadTokens: null,
        outputTokens: 5
      }
    });

    assert.deepEqual(
      execution.events.map((event) => event.type),
      ["execution.started", "session.bound", "progress", "usage.reported", "execution.completed"]
    );
    assert.equal(execution.events[1].sessionId, "session-1");
    assert.equal(execution.events[1].createdAt, "2026-08-01T10:00:01.000Z");
    assert.deepEqual(execution.usage, {
      inputUncachedTokens: 10,
      cacheReadTokens: null,
      cacheWriteTokens: null,
      outputTokens: 5,
      costUsd: null
    });
    assert.deepEqual(registry.validate("agent-result.schema.json", execution.result), { valid: true, errors: [] });
    for (const event of execution.events) {
      assert.deepEqual(registry.validate("engine-event.schema.json", event), { valid: true, errors: [] });
    }
  });

  it("aggregates partial usage without converting unknown values to zero", () => {
    const execution = new FakeEngineAdapter(registry).start({
      runId: "run-engine-2",
      taskId: "TASK-02",
      executionId: "exec-2",
      sessionId: "session-2",
      startedAt: "2026-08-01T10:00:00Z",
      usage: {
        inputUncachedTokens: 7,
        cacheReadTokens: null,
        cacheWriteTokens: 3
      }
    });

    assert.deepEqual(aggregateUsage(execution.events), {
      inputUncachedTokens: 7,
      cacheReadTokens: null,
      cacheWriteTokens: 3,
      outputTokens: null,
      costUsd: null
    });
  });

  it("emits one cancellation terminal event", () => {
    const execution = new FakeEngineAdapter(registry).cancel({
      runId: "run-engine-3",
      taskId: "TASK-03",
      executionId: "exec-3",
      sessionId: "session-3",
      startedAt: "2026-08-01T10:00:00Z",
      reason: "test cancellation"
    });

    assert.deepEqual(
      execution.events.map((event) => event.type),
      ["execution.started", "session.bound", "execution.cancelled"]
    );
    assert.equal(execution.result.status, "FAILED");
  });

  it("rejects duplicate or gapped event sequences", () => {
    const execution = new FakeEngineAdapter(registry).start({
      runId: "run-engine-4",
      taskId: "TASK-04",
      executionId: "exec-4",
      sessionId: "session-4",
      startedAt: "2026-08-01T10:00:00Z"
    });

    assert.throws(
      () => validateEngineEventStream([execution.events[0], execution.events[0]]),
      (error) => error instanceof EngineEventStreamError && error.code === "ENGINE_EVENT_DUPLICATE"
    );
    assert.throws(
      () => validateEngineEventStream([execution.events[0], execution.events[2]]),
      (error) => error instanceof EngineEventStreamError && error.code === "ENGINE_EVENT_SEQUENCE_GAP"
    );
  });
});
