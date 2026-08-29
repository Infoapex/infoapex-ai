import type { ProfiledUsageCheckpoint, UsageCheckpoint, UsagePrediction } from "./usage-checkpoint.js";

export type UsageDriftStatus = "GREEN" | "YELLOW" | "RED" | "NOT_COMPARABLE" | "INSUFFICIENT_HISTORY";

export interface UsageStageDrift {
  readonly planId: string;
  readonly stageId: string;
  readonly calibrationProfileId: string | null;
  readonly startCheckpointId: string;
  readonly endCheckpointId: string;
  readonly actualTokens: number | null;
  readonly usageDeltaPercentagePoints: number | null;
  readonly observedTokensPerPercentagePoint: number | null;
  readonly prediction: UsagePrediction | null;
  readonly tokenErrorPercent: number | null;
  readonly absoluteTokenErrorPercent: number | null;
  readonly rangeHit: boolean | null;
  readonly status: UsageDriftStatus;
  readonly usageMappingStatus: "COMPARABLE" | "NOT_COMPARABLE";
  readonly reasons: readonly string[];
}

export interface UsageDriftReport {
  readonly schemaVersion: "1.1";
  readonly planId: string;
  readonly profile: string | null;
  readonly status: UsageDriftStatus;
  readonly stageCount: number;
  readonly comparableStageCount: number;
  readonly usageComparableStageCount: number;
  readonly predictedStageCount: number;
  readonly meanAbsolutePercentageError: number | null;
  readonly rangeHitRate: number | null;
  readonly medianTokensPerPercentagePoint: number | null;
  readonly stages: readonly UsageStageDrift[];
}

export interface EvaluateUsageDriftOptions {
  readonly checkpoints: readonly UsageCheckpoint[];
  readonly planId: string;
  readonly profile?: string | null;
}

export function evaluateUsageDrift(options: EvaluateUsageDriftOptions): UsageDriftReport {
  const profiled = options.checkpoints.filter(
    (checkpoint): checkpoint is ProfiledUsageCheckpoint =>
      checkpoint.schemaVersion === "1.1" &&
      checkpoint.runId === options.planId &&
      (options.profile == null || checkpoint.calibrationProfileId === options.profile)
  );
  const groups = groupCheckpoints(profiled);
  const stages = [...groups.values()].flatMap((checkpoints) => evaluatePairs(checkpoints));
  const comparable = stages.filter((stage) => stage.status !== "NOT_COMPARABLE");
  const usageComparable = stages.filter((stage) => stage.usageMappingStatus === "COMPARABLE");
  const predicted = comparable.filter((stage) => stage.absoluteTokenErrorPercent !== null);
  const mappingSamples = comparable
    .map((stage) => stage.observedTokensPerPercentagePoint)
    .filter((value): value is number => value !== null);
  const mape = predicted.length > 0 ? average(predicted.map((stage) => stage.absoluteTokenErrorPercent!)) : null;
  const rangeHitRate = predicted.length > 0 ? predicted.filter((stage) => stage.rangeHit).length / predicted.length : null;
  const status = aggregateStatus(stages, mape, rangeHitRate);

  return {
    schemaVersion: "1.1",
    planId: options.planId,
    profile: options.profile ?? null,
    status,
    stageCount: stages.length,
    comparableStageCount: comparable.length,
    usageComparableStageCount: usageComparable.length,
    predictedStageCount: predicted.length,
    meanAbsolutePercentageError: mape,
    rangeHitRate,
    medianTokensPerPercentagePoint: mappingSamples.length > 0 ? median(mappingSamples) : null,
    stages
  };
}

function groupCheckpoints(checkpoints: readonly ProfiledUsageCheckpoint[]): Map<string, ProfiledUsageCheckpoint[]> {
  const groups = new Map<string, ProfiledUsageCheckpoint[]>();
  for (const checkpoint of checkpoints) {
    if (!checkpoint.taskId) {
      continue;
    }
    const key = `${checkpoint.scope}:${checkpoint.taskId}:${checkpoint.calibrationProfileId ?? "unknown"}`;
    const group = groups.get(key) ?? [];
    group.push(checkpoint);
    groups.set(key, group);
  }
  for (const group of groups.values()) {
    group.sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }
  return groups;
}

function evaluatePairs(checkpoints: readonly ProfiledUsageCheckpoint[]): UsageStageDrift[] {
  const results: UsageStageDrift[] = [];
  let start: ProfiledUsageCheckpoint | null = null;

  for (const checkpoint of checkpoints) {
    if (checkpoint.phase === "start") {
      start = checkpoint;
      continue;
    }
    if (start) {
      results.push(evaluatePair(start, checkpoint));
      start = null;
    }
  }
  return results;
}

function evaluatePair(start: ProfiledUsageCheckpoint, end: ProfiledUsageCheckpoint): UsageStageDrift {
  const tokenReasons: string[] = [];
  const usageReasons: string[] = [];
  if (start.engine !== end.engine || start.model !== end.model || start.reasoningEffort !== end.reasoningEffort) {
    tokenReasons.push("MODEL_OR_EFFORT_CHANGED");
  }
  if (start.sessionFingerprint !== end.sessionFingerprint) {
    tokenReasons.push("SESSION_CHANGED");
  }
  if (start.modelContextWindow !== end.modelContextWindow) {
    tokenReasons.push("MODEL_CONTEXT_WINDOW_CHANGED");
  }
  if (start.rateLimitWindowMinutes !== end.rateLimitWindowMinutes) {
    usageReasons.push("RATE_LIMIT_WINDOW_CHANGED");
  }
  if (start.rateLimitResetsAt !== null && end.rateLimitResetsAt !== null && start.rateLimitResetsAt !== end.rateLimitResetsAt) {
    usageReasons.push("RATE_LIMIT_RESET_CHANGED");
  }
  if ((end.parallelSessionCount ?? 0) > 0) {
    tokenReasons.push("PARALLEL_CODEX_SESSION_DETECTED");
  }

  const startTokens = totalTokens(start);
  const endTokens = totalTokens(end);
  const actualTokens =
    start.scope === "development"
      ? startTokens === null || endTokens === null
        ? null
        : endTokens - startTokens
      : endTokens;
  if (actualTokens === null) {
    tokenReasons.push("TOKEN_USAGE_UNKNOWN");
  } else if (actualTokens < 0) {
    tokenReasons.push("CUMULATIVE_TOKENS_DECREASED");
  }

  const usageDelta =
    start.percentUsedReported === null || end.percentUsedReported === null
      ? null
      : end.percentUsedReported - start.percentUsedReported;
  if (usageDelta === null) {
    usageReasons.push("USAGE_PERCENT_UNKNOWN");
  } else if (usageDelta <= 0) {
    usageReasons.push("USAGE_PERCENT_DID_NOT_INCREASE");
  }

  const tokenComparable = tokenReasons.length === 0;
  const usageComparable = tokenComparable && usageReasons.length === 0;
  const prediction = start.prediction;
  const tokenErrorPercent =
    tokenComparable && prediction && actualTokens !== null && prediction.medianTokens > 0
      ? ((actualTokens - prediction.medianTokens) / prediction.medianTokens) * 100
      : null;
  const absoluteTokenErrorPercent = tokenErrorPercent === null ? null : Math.abs(tokenErrorPercent);
  const rangeHit =
    tokenComparable && prediction && actualTokens !== null
      ? actualTokens >= prediction.lowTokens && actualTokens <= prediction.highTokens
      : null;
  const observedTokensPerPercentagePoint =
    usageComparable && actualTokens !== null && usageDelta !== null ? actualTokens / usageDelta : null;
  const status = !tokenComparable
    ? "NOT_COMPARABLE"
    : prediction === null
      ? "INSUFFICIENT_HISTORY"
      : classifyPrediction(absoluteTokenErrorPercent!, rangeHit!);

  return {
    planId: start.runId,
    stageId: start.taskId!,
    calibrationProfileId: start.calibrationProfileId,
    startCheckpointId: start.checkpointId,
    endCheckpointId: end.checkpointId,
    actualTokens: actualTokens !== null && actualTokens >= 0 ? actualTokens : null,
    usageDeltaPercentagePoints: usageDelta !== null && usageDelta > 0 ? usageDelta : null,
    observedTokensPerPercentagePoint,
    prediction,
    tokenErrorPercent,
    absoluteTokenErrorPercent,
    rangeHit,
    status,
    usageMappingStatus: usageComparable ? "COMPARABLE" : "NOT_COMPARABLE",
    reasons: [...tokenReasons, ...usageReasons]
  };
}

function totalTokens(checkpoint: ProfiledUsageCheckpoint): number | null {
  const tokens = checkpoint.tokens;
  if (
    tokens.inputUncachedTokens === null &&
    tokens.cacheReadTokens === null &&
    tokens.cacheWriteTokens === null &&
    tokens.outputTokens === null
  ) {
    return null;
  }
  return (
    (tokens.inputUncachedTokens ?? 0) +
    (tokens.cacheReadTokens ?? 0) +
    (tokens.cacheWriteTokens ?? 0) +
    (tokens.outputTokens ?? 0)
  );
}

function classifyPrediction(error: number, rangeHit: boolean): UsageDriftStatus {
  if (error <= 20 && rangeHit) {
    return "GREEN";
  }
  if (error <= 35 || rangeHit) {
    return "YELLOW";
  }
  return "RED";
}

function aggregateStatus(
  stages: readonly UsageStageDrift[],
  mape: number | null,
  rangeHitRate: number | null
): UsageDriftStatus {
  if (stages.length === 0 || mape === null || rangeHitRate === null) {
    return stages.some((stage) => stage.status === "NOT_COMPARABLE") ? "NOT_COMPARABLE" : "INSUFFICIENT_HISTORY";
  }
  if (mape <= 20 && rangeHitRate >= 0.8) {
    return "GREEN";
  }
  if (mape <= 35 && rangeHitRate >= 0.6) {
    return "YELLOW";
  }
  return "RED";
}

function average(values: readonly number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1]! + sorted[middle]!) / 2 : sorted[middle]!;
}
