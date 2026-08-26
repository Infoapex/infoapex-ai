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

test("fails over mid-task from a quota failure to the next routed candidate", () => {
  const attempts: string[] = [];
  const result = executeTaskWithFallback({
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

test("does not fail over when the task itself fails deterministically", () => {
  const attempts: string[] = [];
  const result = executeTaskWithFallback({
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

test("does not bypass a Codex sandbox policy blocker through engine fallback", () => {
  const started: string[] = [];
  const result = executeTaskWithFallback({
    candidates: [
      { engine: "codex", model: "primary-model" },
      { engine: "claude", model: "fallback-model" }
    ],
    projectConfig: null,
    request: {
      runId: "run-routing-policy",
      taskId: "TASK-3",
      executionId: "execution-3",
      sessionId: "session-3",
      worktreePath: ".",
      prompt: "Implement the task",
      startedAt: new Date(0).toISOString()
    },
    adapterFactory: (candidate) => ({
      doctor: () => candidate.engine === "codex"
        ? {
            status: "BLOCKED",
            findings: [{
              code: "CODEX_DANGER_FULL_ACCESS_UNAUTHORIZED",
              message: "Explicit elevation approval is missing."
            }]
          }
        : { status: "PASS", findings: [] },
      start: (request) => {
        started.push(candidate.engine);
        return successfulExecution(request) as never;
      }
    })
  });

  assert.deepEqual(started, []);
  assert.equal(result.candidate.engine, "codex");
  assert.equal(result.attempts.length, 1);
  assert.equal(result.attempts[0]?.availabilityFailure, false);
  assert.equal(result.execution.result.failures[0]?.class, "policy");
});

test("does not start or fail over when immutable candidate binding conflicts", () => {
  const started: string[] = [];
  const result = executeTaskWithFallback({
    candidates: [
      { engine: "codex", model: "primary-model" },
      { engine: "claude", model: "fallback-model" }
    ],
    projectConfig: null,
    request: {
      runId: "run-routing-binding",
      taskId: "TASK-4",
      executionId: "execution-4",
      sessionId: "session-4",
      worktreePath: ".",
      prompt: "Implement the task",
      startedAt: new Date(0).toISOString()
    },
    adapterFactory: (candidate) => ({
      doctor: () => ({ status: "PASS", findings: [] }),
      start: (request) => {
        started.push(candidate.engine);
        return successfulExecution(request) as never;
      }
    }),
    beforeStart: () => ({ status: "BLOCKED", message: "Immutable sandbox decision changed." })
  });

  assert.deepEqual(started, []);
  assert.equal(result.candidate.engine, "codex");
  assert.equal(result.attempts.length, 1);
  assert.equal(result.execution.result.failures[0]?.class, "policy");
});

function successfulExecution(request: {
  readonly runId: string;
  readonly taskId: string;
  readonly executionId: string;
  readonly sessionId: string;
}) {
  return {
    executionId: request.executionId,
    sessionId: request.sessionId,
    events: [],
    usage: { inputUncachedTokens: null, cacheReadTokens: null, cacheWriteTokens: null, outputTokens: null, costUsd: null },
    result: {
      schemaVersion: "1.0",
      runId: request.runId,
      taskId: request.taskId,
      status: "DONE",
      summary: "completed",
      touchedFiles: [],
      failures: []
    }
  };
}
