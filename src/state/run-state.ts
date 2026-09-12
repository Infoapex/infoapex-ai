import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { atomicWriteJson } from "./atomic-file.js";

export type RunTerminalStatus = "DONE" | "BLOCKED" | "CANCELLED";
export type RunStatus = "NEW" | "RUNNING" | RunTerminalStatus;
export interface RunTaskState { readonly status: "COMMITTED" | "GATED"; readonly commit: string; readonly gate?: "PASS"; }
export interface RunEffectState { readonly status: "INTENT" | "DONE"; readonly key: string; readonly result?: Readonly<Record<string, unknown>>; }
export interface RunState {
  readonly schemaVersion: "1.0"; readonly runId: string; readonly provider: "fake" | "codex" | "claude";
  readonly status: RunStatus; readonly createdAt: string; readonly updatedAt: string; readonly manifestSha256: string;
  readonly tasks: Readonly<Record<string, RunTaskState>>; readonly effects: Readonly<Record<string, RunEffectState>>;
  readonly decision?: { readonly code: string; readonly message: string };
}

export class RunStateStore {
  readonly path: string;
  constructor(readonly runRoot: string) { this.path = join(runRoot, "state.json"); }
  read(): RunState | null {
    if (!existsSync(this.path)) return null;
    try { const value = JSON.parse(readFileSync(this.path, "utf8")) as RunState; if (!valid(value)) throw new Error("invalid"); return value; }
    catch { throw new RunStateError("STATE_INVALID", "Recovery refuses an invalid state document."); }
  }
  create(runId: string, provider: RunState["provider"], manifestSha256: string, now: string): RunState {
    const current = this.read();
    if (current) return current;
    const value: RunState = { schemaVersion: "1.0", runId, provider, status: "NEW", createdAt: now, updatedAt: now, manifestSha256, tasks: {}, effects: {} };
    atomicWriteJson(this.path, value); return value;
  }
  write(next: RunState): RunState { if (!valid(next)) throw new RunStateError("STATE_INVALID", "Refusing to write invalid state."); atomicWriteJson(this.path, next); return next; }
  transition(current: RunState, status: RunStatus, now: string, decision?: RunState["decision"]): RunState {
    if (current.status === status) return current;
    if ((current.status === "DONE" || current.status === "BLOCKED" || current.status === "CANCELLED") && status !== current.status) throw new RunStateError("TERMINAL_IMMUTABLE", "A terminal run cannot be reopened.");
    if (!((current.status === "NEW" && status === "RUNNING") || (current.status === "RUNNING" && (status === "DONE" || status === "BLOCKED" || status === "CANCELLED")))) throw new RunStateError("TRANSITION_INVALID", "Invalid run state transition.");
    return this.write({ ...current, status, updatedAt: now, ...(decision ? { decision } : {}) });
  }
  commitTask(current: RunState, taskId: string, commit: string, now: string): RunState {
    const prior = current.tasks[taskId]; if (prior) { if (prior.commit !== commit) throw new RunStateError("TASK_COMMIT_CONFLICT", `Task ${taskId} already has a different commit.`); return current; }
    return this.write({ ...current, updatedAt: now, tasks: { ...current.tasks, [taskId]: { status: "COMMITTED", commit } } });
  }
  gateTask(current: RunState, taskId: string, now: string): RunState {
    const prior = current.tasks[taskId]; if (!prior) throw new RunStateError("TASK_NOT_COMMITTED", `Task ${taskId} has no commit.`); if (prior.gate === "PASS") return current;
    return this.write({ ...current, updatedAt: now, tasks: { ...current.tasks, [taskId]: { ...prior, status: "GATED", gate: "PASS" } } });
  }
  recordEffectIntent(current: RunState, key: string, now: string): RunState {
    const prior = current.effects[key]; if (prior) return current;
    return this.write({ ...current, updatedAt: now, effects: { ...current.effects, [key]: { status: "INTENT", key } } });
  }
  completeEffect(current: RunState, key: string, result: Readonly<Record<string, unknown>>, now: string): RunState {
    const prior = current.effects[key]; if (!prior) throw new RunStateError("EFFECT_INTENT_MISSING", `Effect ${key} lacks an intent record.`); if (prior.status === "DONE") return current;
    return this.write({ ...current, updatedAt: now, effects: { ...current.effects, [key]: { status: "DONE", key, result } } });
  }
}
export class RunStateError extends Error { constructor(readonly code: string, message: string) { super(message); } }
function valid(value: unknown): value is RunState {
  if (!value || typeof value !== "object") return false; const state = value as Partial<RunState>;
  return state.schemaVersion === "1.0" && typeof state.runId === "string" && (state.provider === "fake" || state.provider === "codex" || state.provider === "claude") &&
    (state.status === "NEW" || state.status === "RUNNING" || state.status === "DONE" || state.status === "BLOCKED" || state.status === "CANCELLED") && typeof state.manifestSha256 === "string" && !!state.tasks && typeof state.tasks === "object" && !!state.effects && typeof state.effects === "object";
}
