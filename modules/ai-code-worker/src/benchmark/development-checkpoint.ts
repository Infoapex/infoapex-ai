import { createHash } from "node:crypto";
import { resolve } from "node:path";
import {
  findCodexRolloutsModifiedSince,
  findLatestCodexRolloutPath,
  readCodexSessionLog,
  type FindLatestCodexRolloutOptions
} from "./read-codex-session.js";
import {
  resolveUsageCheckpointLogPath,
  UsageCheckpointLog,
  type ProfiledUsageCheckpoint,
  type UsageCheckpointTaskKind,
  type UsageCheckpointTaskRisk,
  type UsagePrediction
} from "./usage-checkpoint.js";

export interface AppendDevelopmentCheckpointOptions {
  readonly repositoryPath: string;
  readonly planId: string;
  readonly stageId: string;
  readonly phase: "start" | "end";
  readonly engine: "codex";
  readonly taskKind?: UsageCheckpointTaskKind | null;
  readonly taskRisk?: UsageCheckpointTaskRisk | null;
  readonly prediction?: UsagePrediction | null;
  readonly rolloutPath?: string | null;
  readonly codexSessions?: FindLatestCodexRolloutOptions;
  readonly now?: string;
}

export type DevelopmentCheckpointErrorCode =
  | "INVALID_IDENTIFIER"
  | "ROLLOUT_NOT_FOUND"
  | "USAGE_NOT_FOUND"
  | "START_CHECKPOINT_NOT_FOUND";

export class DevelopmentCheckpointError extends Error {
  constructor(
    readonly code: DevelopmentCheckpointErrorCode,
    message: string
  ) {
    super(message);
    this.name = "DevelopmentCheckpointError";
  }
}

/** Captures numeric usage from the current Codex development session. The rollout
 *  is read-only and no transcript text or local path is written to the checkpoint. */
export function appendDevelopmentCheckpoint(options: AppendDevelopmentCheckpointOptions): ProfiledUsageCheckpoint {
  requireIdentifier("planId", options.planId);
  requireIdentifier("stageId", options.stageId);

  const now = options.now ?? new Date().toISOString();
  const rolloutPath = options.rolloutPath ?? findLatestCodexRolloutPath(options.codexSessions);
  if (!rolloutPath) {
    throw new DevelopmentCheckpointError("ROLLOUT_NOT_FOUND", "No Codex rollout file is available for this checkpoint.");
  }

  const summary = readCodexSessionLog(rolloutPath);
  if (!summary?.totalTokenUsage) {
    throw new DevelopmentCheckpointError("USAGE_NOT_FOUND", "The selected Codex rollout has no cumulative token_count event.");
  }

  const log = new UsageCheckpointLog(resolveUsageCheckpointLogPath(options.repositoryPath));
  const existing = log.read().checkpoints;
  const matchingStart = [...existing]
    .reverse()
    .find(
      (checkpoint) =>
        checkpoint.schemaVersion === "1.1" &&
        checkpoint.scope === "development" &&
        checkpoint.runId === options.planId &&
        checkpoint.taskId === options.stageId &&
        checkpoint.engine === options.engine &&
        checkpoint.phase === "start"
    );

  if (options.phase === "end" && !matchingStart) {
    throw new DevelopmentCheckpointError(
      "START_CHECKPOINT_NOT_FOUND",
      `No start checkpoint exists for ${options.planId}/${options.stageId}.`
    );
  }

  const sessions =
    options.phase === "end" && matchingStart
      ? findCodexRolloutsModifiedSince(new Date(matchingStart.createdAt), options.codexSessions, new Date(now))
      : [rolloutPath];
  const currentPath = resolve(rolloutPath).toLowerCase();
  const parallelSessionCount = sessions.filter((path) => resolve(path).toLowerCase() !== currentPath).length;
  const model = summary.model;
  const reasoningEffort = summary.reasoningEffort;
  const total = summary.totalTokenUsage;
  const cached = total.cachedInputTokens;
  const inputUncachedTokens =
    total.inputTokens === null ? null : cached === null ? total.inputTokens : Math.max(0, total.inputTokens - cached);
  const calibrationProfileId = profileId(options.engine, model, reasoningEffort);

  return log.append({
    checkpointId: checkpointId(options.planId, options.stageId, options.phase, now),
    runId: options.planId,
    taskId: options.stageId,
    scope: "development",
    engine: options.engine,
    phase: options.phase,
    createdAt: now,
    taskKind: options.taskKind ?? matchingStart?.taskKind ?? null,
    taskRisk: options.taskRisk ?? matchingStart?.taskRisk ?? null,
    tokens: {
      inputUncachedTokens,
      cacheReadTokens: cached,
      cacheWriteTokens: null,
      outputTokens: total.outputTokens,
      costUsd: null
    },
    contextEstimateTokens: total.totalTokens,
    percentUsedReported: summary.usedPercent,
    percentUsedEstimated: null,
    model,
    reasoningEffort,
    modelContextWindow: summary.modelContextWindow,
    rateLimitWindowMinutes: summary.windowMinutes,
    rateLimitResetsAt: summary.resetsAt,
    calibrationProfileId,
    sessionFingerprint: fingerprint(summary.sessionId ?? rolloutPath),
    parallelSessionCount,
    prediction: options.phase === "start" ? options.prediction ?? null : null
  });
}

export function profileId(engine: string, model: string | null, reasoningEffort: string | null): string {
  return `${engine}:${model ?? "unknown-model"}:${reasoningEffort ?? "unknown-effort"}`;
}

function requireIdentifier(label: string, value: string): void {
  if (!/^[A-Za-z0-9._-]+$/.test(value)) {
    throw new DevelopmentCheckpointError("INVALID_IDENTIFIER", `${label} must match ^[A-Za-z0-9._-]+$.`);
  }
}

function checkpointId(planId: string, stageId: string, phase: string, now: string): string {
  const timestamp = now.replace(/[^0-9]/g, "");
  return `${planId}-${stageId}-${phase}-${timestamp}`;
}

function fingerprint(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex").slice(0, 16);
}
