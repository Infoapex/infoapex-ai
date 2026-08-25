import type { RunEvent } from "./event-log.js";

export type RunReplayStatus =
  | "EMPTY"
  | "CREATED"
  | "INTENT_CREATED"
  | "MANIFEST_COMPILED"
  | "MANIFEST_FROZEN"
  | "AUTHORIZED"
  | "RECOVERING"
  | "SUPERSEDED"
  | "DONE"
  | "BLOCKED";

export interface RunReplay {
  readonly runId: string | null;
  readonly status: RunReplayStatus;
  readonly lastSequence: number | null;
  readonly lastEventType: string | null;
  readonly taskStates: Readonly<Record<string, TaskReplayStatus>>;
  readonly gateStates: Readonly<Record<string, GateReplayStatus>>;
  readonly blockedReason: string | null;
}

export type TaskReplayStatus = "INPUT_FROZEN" | "STALE" | "WORKTREE_CREATED" | "STARTED" | "COMMITTED" | "FINISHED";
export type GateReplayStatus = "STARTED" | "FINISHED";

export function replayRun(events: readonly RunEvent[]): RunReplay {
  let status: RunReplayStatus = "EMPTY";
  let blockedReason: string | null = null;
  const taskStates: Record<string, TaskReplayStatus> = {};
  const gateStates: Record<string, GateReplayStatus> = {};

  for (const event of events) {
    switch (event.type) {
      case "run.created":
        status = "CREATED";
        break;
      case "run.intent-created":
        status = "INTENT_CREATED";
        break;
      case "manifest.compiled":
        status = "MANIFEST_COMPILED";
        break;
      case "manifest.frozen":
        status = "MANIFEST_FROZEN";
        break;
      case "authorization.bound":
        status = "AUTHORIZED";
        break;
      case "run.recovering":
        status = "RECOVERING";
        break;
      case "run.superseded":
        status = "SUPERSEDED";
        break;
      case "run.done":
        status = "DONE";
        break;
      case "run.blocked":
        status = "BLOCKED";
        blockedReason = readString(event.payload.reason) ?? readString(event.payload.code);
        break;
      case "task.input-frozen":
        setTaskState(taskStates, event, "INPUT_FROZEN");
        break;
      case "task.stale":
        setTaskState(taskStates, event, "STALE");
        break;
      case "task.worktree-created":
        setTaskState(taskStates, event, "WORKTREE_CREATED");
        break;
      case "task.started":
        setTaskState(taskStates, event, "STARTED");
        break;
      case "task.committed":
        setTaskState(taskStates, event, "COMMITTED");
        break;
      case "task.finished":
        setTaskState(taskStates, event, "FINISHED");
        break;
      case "gate.started":
        setGateState(gateStates, event, "STARTED");
        break;
      case "gate.finished":
        setGateState(gateStates, event, "FINISHED");
        break;
      case "review.finished":
        break;
    }
  }

  const lastEvent = events.at(-1);

  return {
    runId: events[0]?.runId ?? null,
    status,
    lastSequence: lastEvent?.sequence ?? null,
    lastEventType: lastEvent?.type ?? null,
    taskStates,
    gateStates,
    blockedReason
  };
}

function setTaskState(states: Record<string, TaskReplayStatus>, event: RunEvent, status: TaskReplayStatus): void {
  const taskId = readString(event.payload.taskId);

  if (taskId) {
    states[taskId] = status;
  }
}

function setGateState(states: Record<string, GateReplayStatus>, event: RunEvent, status: GateReplayStatus): void {
  const gateId = readString(event.payload.gateId) ?? readString(event.payload.command);

  if (gateId) {
    states[gateId] = status;
  }
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}
