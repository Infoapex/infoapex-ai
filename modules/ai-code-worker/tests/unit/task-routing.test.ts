import assert from "node:assert/strict";
import test from "node:test";
import { executeTaskWithFallback, isAvailabilityFailure } from "../../src/routing/task-execution.js";

test("classifies quota and provider unavailability as failover signals", () => {
  const execution = {
    executionId: "e",
    sessionId: "s",
    events: [],
    usage: { inputUncachedTokens: null, cacheReadTokens: null, cacheWriteTokens: null, outputTokens: null, costUsd: null },
    result: {
      schemaVersion: "1.0",
      runId: "r",
      taskId: "t",
      status: "FAILED",
      summary: "failed",
      touchedFiles: [],
      failures: [{ class: "engine", message: "HTTP 429: rate limit exceeded" }]
    }
  } as never;
  assert.equal(isAvailabilityFailure(execution), true);
});

test("classifies provider sandbox and permission failures as failover signals", () => {
  const execution = {
    executionId: "e",
    sessionId: "s",
    events: [],
    usage: { inputUncachedTokens: null, cacheReadTokens: null, cacheWriteTokens: null, outputTokens: null, costUsd: null },
    result: {
      schemaVersion: "1.0",
      runId: "r",
      taskId: "t",
      status: "FAILED",
      summary: "failed",
      touchedFiles: [],
      failures: [{ class: "engine", message: "Write access was rejected by the read-only sandbox." }]
    }
  } as never;
  assert.equal(isAvailabilityFailure(execution), true);
});

test("does not fail over for deterministic implementation failures", () => {
  const execution = {
    executionId: "e",
    sessionId: "s",
    events: [],
    usage: { inputUncachedTokens: null, cacheReadTokens: null, cacheWriteTokens: null, outputTokens: null, costUsd: null },
    result: {
      schemaVersion: "1.0",
      runId: "r",
      taskId: "t",
      status: "FAILED",
      summary: "failed",
      touchedFiles: [],
      failures: [{ class: "deterministic", message: "TypeScript test failed" }]
    }
  } as never;
  assert.equal(isAvailabilityFailure(execution), false);
});

test("fails over mid-task from a quota failure to the next routed candidate", async () => {
  const attempts: string[] = [];
  const result = await executeTaskWithFallback({
    candidates: [
      { engine: "codex", model: "primary-model" },
      { engine: "claude", model: "fallback-model" }
    ],
    projectConfig: null,
    request: {
      runId: "run-routing",
      taskId: "TASK-1",
      executionId: "execution-1",
      sessionId: "session-1",
      worktreePath: ".",
      prompt: "Implement the task",
      startedAt: new Date(0).toISOString()
    },
    adapterFactory: (candidate) => ({
      doctor: () => ({ status: "PASS", findings: [] }),
      start: (request) => {
        attempts.push(candidate.engine);
        const failed = candidate.engine === "codex";
        return {
          executionId: request.executionId,
          sessionId: request.sessionId,
          events: [],
          usage: { inputUncachedTokens: null, cacheReadTokens: null, cacheWriteTokens: null, outputTokens: null, costUsd: null },
          result: {
            schemaVersion: "1.0",
            runId: request.runId,
            taskId: request.taskId,
            status: failed ? "FAILED" : "DONE",
            summary: failed ? "quota exhausted" : "completed",
            touchedFiles: [],
            failures: failed ? [{ class: "engine", message: "HTTP 429 quota exhausted" }] : []
          }
        } as never;
      }
    })
  });

  assert.deepEqual(attempts, ["codex", "claude"]);
  assert.equal(result.candidate.engine, "claude");
  assert.equal(result.attempts.length, 2);
  assert.equal(result.attempts[0]?.availabilityFailure, true);
  assert.equal(result.execution.result.status, "DONE");
});

test("does not fail over when the task itself fails deterministically", async () => {
  const attempts: string[] = [];
  const result = await executeTaskWithFallback({
    candidates: [
      { engine: "codex", model: "primary-model" },
      { engine: "claude", model: "fallback-model" }
    ],
    projectConfig: null,
    request: {
      runId: "run-routing-deterministic",
      taskId: "TASK-2",
      executionId: "execution-2",
      sessionId: "session-2",
      worktreePath: ".",
      prompt: "Implement the task",
      startedAt: new Date(0).toISOString()
    },
    adapterFactory: (candidate) => ({
      doctor: () => ({ status: "PASS", findings: [] }),
      start: (request) => {
        attempts.push(candidate.engine);
        return {
          executionId: request.executionId,
          sessionId: request.sessionId,
          events: [],
          usage: { inputUncachedTokens: null, cacheReadTokens: null, cacheWriteTokens: null, outputTokens: null, costUsd: null },
          result: {
            schemaVersion: "1.0",
            runId: request.runId,
            taskId: request.taskId,
            status: "FAILED",
            summary: "tests failed",
            touchedFiles: [],
            failures: [{ class: "deterministic", message: "TypeScript test failed" }]
          }
        } as never;
      }
    })
  });

  assert.deepEqual(attempts, ["codex"]);
  assert.equal(result.candidate.engine, "codex");
  assert.equal(result.attempts.length, 1);
  assert.equal(result.attempts[0]?.availabilityFailure, false);
});
