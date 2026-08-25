import { SchemaRegistry } from "../schema/json-schema.js";
import { aggregateUsage, createEngineEvent, validateEngineEventStream, type EngineEvent, type EngineUsage } from "./engine-event.js";

export interface FakeEngineRequest {
  readonly runId: string;
  readonly taskId: string;
  readonly executionId: string;
  readonly sessionId: string;
  readonly startedAt: string;
  readonly result?: "DONE" | "FAILED" | "BLOCKED";
  readonly touchedFiles?: readonly string[];
  readonly usage?: Partial<EngineUsage>;
}

export interface AgentExecutionResult {
  readonly schemaVersion: "1.0";
  readonly runId: string;
  readonly taskId: string;
  readonly status: "DONE" | "FAILED" | "BLOCKED";
  readonly summary: string;
  readonly touchedFiles: readonly string[];
  readonly failures: ReadonlyArray<{
    readonly class: "deterministic" | "flaky" | "infrastructure" | "policy" | "engine";
    readonly message: string;
  }>;
}

export interface FakeEngineExecution {
  readonly executionId: string;
  readonly sessionId: string;
  readonly events: readonly EngineEvent[];
  readonly usage: EngineUsage;
  readonly result: AgentExecutionResult;
}

export class FakeEngineAdapter {
  constructor(private readonly registry = SchemaRegistry.load()) {}

  start(request: FakeEngineRequest): FakeEngineExecution {
    const resultStatus = request.result ?? "DONE";
    const terminalType =
      resultStatus === "DONE" ? "execution.completed" : resultStatus === "BLOCKED" ? "execution.failed" : "execution.failed";
    const usage = normalizeUsage(request.usage ?? {});
    const events = [
      createEngineEvent({
        executionId: request.executionId,
        startedAt: request.startedAt,
        sequence: 0,
        type: "execution.started",
        payload: { engine: "fake", taskId: request.taskId },
        registry: this.registry
      }),
      createEngineEvent({
        executionId: request.executionId,
        startedAt: request.startedAt,
        sequence: 1,
        type: "session.bound",
        sessionId: request.sessionId,
        payload: { sessionId: request.sessionId },
        registry: this.registry
      }),
      createEngineEvent({
        executionId: request.executionId,
        startedAt: request.startedAt,
        sequence: 2,
        type: "progress",
        sessionId: request.sessionId,
        payload: { message: "fake engine processed deterministic task" },
        registry: this.registry
      }),
      createEngineEvent({
        executionId: request.executionId,
        startedAt: request.startedAt,
        sequence: 3,
        type: "usage.reported",
        sessionId: request.sessionId,
        payload: usagePayload(usage),
        registry: this.registry
      }),
      createEngineEvent({
        executionId: request.executionId,
        startedAt: request.startedAt,
        sequence: 4,
        type: terminalType,
        sessionId: request.sessionId,
        payload: { status: resultStatus },
        registry: this.registry
      })
    ];

    validateEngineEventStream(events);

    const result: AgentExecutionResult = {
      schemaVersion: "1.0",
      runId: request.runId,
      taskId: request.taskId,
      status: resultStatus,
      summary: `Fake engine ${resultStatus.toLowerCase()} for ${request.taskId}.`,
      touchedFiles: request.touchedFiles ?? [],
      failures:
        resultStatus === "DONE"
          ? []
          : [
              {
                class: resultStatus === "BLOCKED" ? "policy" : "engine",
                message: `Fake engine terminal status: ${resultStatus}`
              }
            ]
    };

    this.registry.assertValid("agent-result.schema.json", result);

    return {
      executionId: request.executionId,
      sessionId: request.sessionId,
      events,
      usage: aggregateUsage(events),
      result
    };
  }

  cancel(request: Omit<FakeEngineRequest, "result"> & { readonly reason: string }): FakeEngineExecution {
    const events = [
      createEngineEvent({
        executionId: request.executionId,
        startedAt: request.startedAt,
        sequence: 0,
        type: "execution.started",
        payload: { engine: "fake", taskId: request.taskId },
        registry: this.registry
      }),
      createEngineEvent({
        executionId: request.executionId,
        startedAt: request.startedAt,
        sequence: 1,
        type: "session.bound",
        sessionId: request.sessionId,
        payload: { sessionId: request.sessionId },
        registry: this.registry
      }),
      createEngineEvent({
        executionId: request.executionId,
        startedAt: request.startedAt,
        sequence: 2,
        type: "execution.cancelled",
        sessionId: request.sessionId,
        payload: { reason: request.reason },
        registry: this.registry
      })
    ];
    const result: AgentExecutionResult = {
      schemaVersion: "1.0",
      runId: request.runId,
      taskId: request.taskId,
      status: "FAILED",
      summary: `Fake engine cancelled for ${request.taskId}.`,
      touchedFiles: [],
      failures: [{ class: "engine", message: request.reason }]
    };

    validateEngineEventStream(events);
    this.registry.assertValid("agent-result.schema.json", result);

    return {
      executionId: request.executionId,
      sessionId: request.sessionId,
      events,
      usage: aggregateUsage(events),
      result
    };
  }
}

function normalizeUsage(usage: Partial<EngineUsage>): EngineUsage {
  return {
    inputUncachedTokens: usage.inputUncachedTokens ?? null,
    cacheReadTokens: usage.cacheReadTokens ?? null,
    cacheWriteTokens: usage.cacheWriteTokens ?? null,
    outputTokens: usage.outputTokens ?? null,
    costUsd: usage.costUsd ?? null
  };
}

function usagePayload(usage: EngineUsage): Record<string, unknown> {
  return {
    inputUncachedTokens: usage.inputUncachedTokens,
    cacheReadTokens: usage.cacheReadTokens,
    cacheWriteTokens: usage.cacheWriteTokens,
    outputTokens: usage.outputTokens,
    costUsd: usage.costUsd
  };
}
