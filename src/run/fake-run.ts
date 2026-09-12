import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { acquireLease, recoverStaleLease, releaseLease } from "../production.js";
import { atomicWriteJson } from "../state/atomic-file.js";
import { EventLog, type RecoveryEvent } from "../state/event-log.js";
import { RunStateError, RunStateStore, type RunState } from "../state/run-state.js";

export type FaultPoint = "before-state-commit" | "after-state-commit" | "provider-timeout" | "provider-rate-limit" | "provider-malformed-output" | "worktree-corrupt" | "cleanup-interrupted";
export interface FakeTask {
  readonly id: string;
  readonly commit: string;
  readonly gate?: () => void;
  /** Only for a caller-approved, idempotency-key-aware local fake action. */
  readonly externalAction?: (idempotencyKey: string) => Readonly<Record<string, unknown>>;
}
export interface FakeRunOptions {
  readonly repositoryRoot?: string; readonly repositoryPath?: string; readonly runId: string; readonly tasks: readonly FakeTask[];
  readonly provider?: "fake"; readonly manifest?: unknown; readonly now?: () => string; readonly fault?: FaultPoint;
  readonly maximumEvidenceEvents?: number; readonly staleLeaseMinutes?: number;
}
export interface FakeRunReport { readonly status: "DONE" | "BLOCKED" | "CANCELLED"; readonly runId: string; readonly executedTasks: readonly string[]; readonly code?: string; readonly statePath: string; readonly eventLogPath: string; }

/** Deterministic core-local coordinator used for recovery testing. It never retries an
 * uncertain external action: an intent without a completion is terminally blocked. */
export function runFake(options: FakeRunOptions): FakeRunReport {
  const repositoryRoot = resolve(options.repositoryRoot ?? options.repositoryPath ?? ".");
  const runRoot = join(repositoryRoot, ".infoapex-ai", "runs", options.runId);
  const now = options.now ?? (() => new Date().toISOString());
  const manifest = options.manifest ?? { tasks: options.tasks.map((task) => ({ id: task.id, commit: task.commit })), provider: "fake" };
  const manifestSha256 = digest(manifest);
  const manifestPath = join(runRoot, "manifest.json");
  const stateStore = new RunStateStore(runRoot);
  const eventLog = new EventLog(join(runRoot, "events.json"), { maximumEvents: options.maximumEvidenceEvents });
  const leaseResult = acquireLease(repositoryRoot, options.runId, { staleLeaseMinutes: options.staleLeaseMinutes });
  if (leaseResult.status !== "PASS") {
    const recovered = recoverStaleLease(repositoryRoot, options.runId, { staleLeaseMinutes: options.staleLeaseMinutes });
    if (recovered.status !== "PASS") return blocked(options.runId, runRoot, eventLog.path, String(recovered.code ?? "RUN_CONCURRENT"));
  }
  try {
    const existing = stateStore.read();
    if (existsSync(manifestPath)) {
      if (digest(JSON.parse(readFileSync(manifestPath, "utf8"))) !== manifestSha256) return blockState(stateStore, existing, eventLog, options.runId, now(), "MANIFEST_MISMATCH", "Resume requires the original immutable manifest.");
    } else atomicWriteJson(manifestPath, manifest);
    let state = stateStore.create(options.runId, "fake", manifestSha256, now());
    if (state.provider !== "fake") return blockState(stateStore, state, eventLog, options.runId, now(), "PROVIDER_MISMATCH", "Recovery never changes provider silently.");
    if (state.manifestSha256 !== manifestSha256) return blockState(stateStore, state, eventLog, options.runId, now(), "MANIFEST_MISMATCH", "Resume requires the original immutable manifest.");
    if (state.status === "DONE" || state.status === "BLOCKED" || state.status === "CANCELLED") return report(state, options.runId, runRoot, eventLog.path);
    state = stateStore.transition(state, "RUNNING", now()); append(eventLog, options.runId, "run.started", now(), {});
    for (const task of options.tasks) {
      const taskState = state.tasks[task.id];
      if (taskState?.gate === "PASS") continue;
      if (options.fault === "provider-timeout" || options.fault === "provider-rate-limit" || options.fault === "provider-malformed-output" || options.fault === "worktree-corrupt") {
        return blockState(stateStore, state, eventLog, options.runId, now(), faultCode(options.fault), "Injected provider/worktree failure; no retry was attempted.");
      }
      if (!taskState) {
        if (options.fault === "before-state-commit") return interrupted(stateStore, state, eventLog, options.runId, now(), "INTERRUPTED_BEFORE_COMMIT", "Interrupted before task state commit.");
        state = stateStore.commitTask(state, task.id, task.commit, now()); append(eventLog, options.runId, "task.committed", now(), { taskId: task.id, commit: task.commit });
        if (options.fault === "after-state-commit") return interrupted(stateStore, state, eventLog, options.runId, now(), "INTERRUPTED_AFTER_COMMIT", "Interrupted after durable task state commit.");
      }
      if (task.externalAction) {
        const key = `${options.runId}:${task.id}:external`;
        const prior = state.effects[key];
        if (prior?.status === "INTENT") return blockState(stateStore, state, eventLog, options.runId, now(), "EFFECT_OUTCOME_UNKNOWN", "An external effect has durable intent but no completion; it will not be repeated.");
        if (!prior) { state = stateStore.recordEffectIntent(state, key, now()); append(eventLog, options.runId, "effect.intent", now(), { taskId: task.id, key }); const result = task.externalAction(key); state = stateStore.completeEffect(state, key, result, now()); append(eventLog, options.runId, "effect.done", now(), { taskId: task.id, key }); }
      }
      task.gate?.(); state = stateStore.gateTask(state, task.id, now()); append(eventLog, options.runId, "task.gated", now(), { taskId: task.id });
    }
    if (options.fault === "cleanup-interrupted") return blockState(stateStore, state, eventLog, options.runId, now(), "CLEANUP_INTERRUPTED", "Cleanup interruption retained bounded recovery evidence.");
    state = stateStore.transition(state, "DONE", now()); append(eventLog, options.runId, "run.done", now(), {}); return report(state, options.runId, runRoot, eventLog.path);
  } catch (error) {
    const state = stateStore.read(); return blockState(stateStore, state, eventLog, options.runId, now(), error instanceof RunStateError ? error.code : "RECOVERY_FAILED", error instanceof Error ? error.message : "Unknown recovery error.");
  } finally { releaseLease(repositoryRoot, options.runId); }
}

function append(log: EventLog, runId: string, type: string, createdAt: string, payload: Record<string, unknown>): void { const count = log.read().events.length; log.append({ eventId: `${runId}:${count}:${type}`, runId, type, createdAt, payload }); }
function blockState(store: RunStateStore, state: RunState | null, log: EventLog, runId: string, now: string, code: string, message: string): FakeRunReport {
  let next = state; try { if (next && next.status === "RUNNING") next = store.transition(next, "BLOCKED", now, { code, message }); append(log, runId, "run.blocked", now, { code }); } catch { /* evidence may be all that is safely writable */ }
  let eventCount: number | null = null; try { eventCount = log.read().events.length; } catch { /* corrupt evidence is reported without reading it */ }
  atomicWriteJson(log.evidencePath(), { schemaVersion: "1.0", runId, code, message, eventCount }); return { status: "BLOCKED", runId, executedTasks: next ? Object.keys(next.tasks) : [], code, statePath: store.path, eventLogPath: log.path };
}
/** An interruption is deliberately not a terminal transition: it leaves the last
 * durable checkpoint intact so an explicit same-id resume can continue idempotently. */
function interrupted(store: RunStateStore, state: RunState, log: EventLog, runId: string, now: string, code: string, message: string): FakeRunReport {
  append(log, runId, "run.interrupted", now, { code }); atomicWriteJson(log.evidencePath(), { schemaVersion: "1.0", runId, code, message, resumable: true, eventCount: log.read().events.length });
  return { status: "BLOCKED", runId, executedTasks: Object.keys(state.tasks), code, statePath: store.path, eventLogPath: log.path };
}
function blocked(runId: string, runRoot: string, eventLogPath: string, code: string): FakeRunReport { return { status: "BLOCKED", runId, executedTasks: [], code, statePath: join(runRoot, "state.json"), eventLogPath }; }
function report(state: RunState, runId: string, runRoot: string, eventLogPath: string): FakeRunReport { return { status: state.status === "NEW" || state.status === "RUNNING" ? "BLOCKED" : state.status, runId, executedTasks: Object.keys(state.tasks), code: state.decision?.code, statePath: join(runRoot, "state.json"), eventLogPath }; }
function digest(value: unknown): string { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }
function faultCode(fault: FaultPoint): string { return ({ "provider-timeout": "PROVIDER_TIMEOUT", "provider-rate-limit": "PROVIDER_RATE_LIMIT", "provider-malformed-output": "PROVIDER_OUTPUT_INVALID", "worktree-corrupt": "WORKTREE_CORRUPT" } as Partial<Record<FaultPoint, string>>)[fault] ?? "RECOVERY_FAILED"; }
