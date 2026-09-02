import { estimateClaudePercentFromTokens, fitTokensPerPercentPoint, type CalibrationPoint } from "./claude-calibration.js";
import type {
  UsageCheckpoint,
  UsageCheckpointEngine,
  UsageCheckpointTaskKind,
  UsageCheckpointTaskRisk
} from "./usage-checkpoint.js";

export interface UsageEstimateProfile {
  readonly engine: UsageCheckpointEngine;
  readonly model: string | null;
  readonly reasoningEffort: string | null;
}

export interface PlanTaskShape {
  readonly id: string;
  readonly kind: UsageCheckpointTaskKind;
  readonly risk: UsageCheckpointTaskRisk;
  readonly acceptanceCriteria: readonly string[];
}

export interface TokenRange {
  readonly low: number;
  readonly median: number;
  readonly high: number;
}

export interface TaskUsageEstimate {
  readonly taskId: string;
  readonly kind: UsageCheckpointTaskKind;
  readonly risk: UsageCheckpointTaskRisk;
  readonly sampleSize: number;
  /** null when there is no historical data for this task's kind+risk bucket yet -
   *  never silently assumed to be 0. */
  readonly tokens: TokenRange | null;
}

export interface PlanUsageEstimate {
  readonly perTask: readonly TaskUsageEstimate[];
  /** Sum across tasks that DO have historical data. Partial (an undercount) if
   *  `tasksWithoutHistory` is non-empty - check that list before treating this as a
   *  full-plan estimate. */
  readonly totalTokens: TokenRange | null;
  readonly tasksWithoutHistory: readonly string[];
  /** Null preserves the legacy mixed-profile behavior. A non-null profile makes
   *  history selection exact and prevents samples from another model/effort from
   *  entering the estimate. */
  readonly profile: UsageEstimateProfile | null;
  /** Derived from totalTokens via the Claude tokens-per-%5h-point calibration
   *  (claude-calibration.ts's manually-seeded points - Claude has no local %5h/%week
   *  reading anywhere to calibrate against automatically). */
  readonly estimatedClaudePercent: TokenRange | null;
  /** Derived from totalTokens via a tokens-per-%5h-point ratio fitted from this
   *  project's OWN real run history (deriveCodexCalibrationPoints below), not a
   *  manually-seeded table - unlike Claude, Codex's rollout reports a real, measured
   *  quota percent per run (see read-codex-session.ts), so every completed real
   *  Codex run is itself a calibration point. `null` when fewer than
   *  `MINIMUM_CODEX_CALIBRATION_POINTS` real (tokens, percent) pairs exist yet -
   *  never fabricated from zero real data. */
  readonly estimatedCodexPercent: TokenRange | null;
}

const MINIMUM_CODEX_CALIBRATION_POINTS = 2;

export interface EstimateUsageForPlanOptions {
  readonly tasks: readonly PlanTaskShape[];
  readonly history: readonly UsageCheckpoint[];
  readonly claudeCalibrationPoints?: readonly CalibrationPoint[];
  readonly profile?: UsageEstimateProfile | null;
}

export function profileKey(profile: UsageEstimateProfile): string {
  return `${profile.engine}:${profile.model ?? "unknown-model"}:${profile.reasoningEffort ?? "unknown-effort"}`;
}

export function bucketKey(kind: string, risk: string, profile?: UsageEstimateProfile | null): string {
  return profile ? `${profileKey(profile)}:${kind}:${risk}` : `${kind}:${risk}`;
}

/** One real total-token sample per completed task execution, bucketed by task
 *  kind+risk - the "shape" the estimator groups by (Part A stage 5). Only "end"
 *  checkpoints at task scope carry real usage; "start" checkpoints and run-scope
 *  checkpoints are not historical task samples. */
export function bucketHistoricalUsage(
  checkpoints: readonly UsageCheckpoint[],
  profile: UsageEstimateProfile | null = null
): ReadonlyMap<string, readonly number[]> {
  const buckets = new Map<string, number[]>();

  for (const checkpoint of checkpoints) {
    if (checkpoint.scope !== "task" || checkpoint.phase !== "end" || !checkpoint.taskKind || !checkpoint.taskRisk) {
      continue;
    }

    const checkpointProfile = profileFromCheckpoint(checkpoint);
    if (profile && !sameProfile(profile, checkpointProfile)) {
      continue;
    }

    const tokens = totalTokensForCheckpoint(checkpoint);

    if (tokens === null) {
      continue;
    }

    const key = bucketKey(checkpoint.taskKind, checkpoint.taskRisk, profile);
    const bucket = buckets.get(key) ?? [];
    bucket.push(tokens);
    buckets.set(key, bucket);
  }

  return buckets;
}

/** Simple average/median per task kind+risk bucket, deliberately not a fancier
 *  model - this is explicitly a "learns over time" tool, not a one-shot ML project
 *  (Part A stage 5). A bucket with zero historical samples is reported as such
 *  (tokens: null, taskId listed in tasksWithoutHistory), never silently assumed to
 *  cost 0. */
export function estimateUsageForPlan(options: EstimateUsageForPlanOptions): PlanUsageEstimate {
  const profile = options.profile ?? null;
  const buckets = bucketHistoricalUsage(options.history, profile);
  const perTask: TaskUsageEstimate[] = options.tasks.map((task) => {
    const samples = buckets.get(bucketKey(task.kind, task.risk, profile)) ?? [];

    return {
      taskId: task.id,
      kind: task.kind,
      risk: task.risk,
      sampleSize: samples.length,
      tokens: samples.length > 0 ? rangeFromSamples(samples) : null
    };
  });

  const tasksWithHistory = perTask.filter((task): task is TaskUsageEstimate & { tokens: TokenRange } => task.tokens !== null);
  const tasksWithoutHistory = perTask.filter((task) => task.tokens === null).map((task) => task.taskId);

  const totalTokens: TokenRange | null =
    tasksWithHistory.length === 0
      ? null
      : {
          low: sum(tasksWithHistory.map((task) => task.tokens.low)),
          median: sum(tasksWithHistory.map((task) => task.tokens.median)),
          high: sum(tasksWithHistory.map((task) => task.tokens.high))
        };

  const estimatedClaudePercent: TokenRange | null =
    totalTokens === null
      ? null
      : {
          low: estimateClaudePercentFromTokens(totalTokens.low, options.claudeCalibrationPoints).percent,
          median: estimateClaudePercentFromTokens(totalTokens.median, options.claudeCalibrationPoints).percent,
          high: estimateClaudePercentFromTokens(totalTokens.high, options.claudeCalibrationPoints).percent
        };

  const codexCalibrationPoints = deriveCodexCalibrationPoints(options.history);
  const estimatedCodexPercent: TokenRange | null =
    totalTokens === null || codexCalibrationPoints.length < MINIMUM_CODEX_CALIBRATION_POINTS
      ? null
      : (() => {
          const tokensPerPercentPoint = fitTokensPerPercentPoint(codexCalibrationPoints);
          return {
            low: totalTokens.low / tokensPerPercentPoint,
            median: totalTokens.median / tokensPerPercentPoint,
            high: totalTokens.high / tokensPerPercentPoint
          };
        })();

  return { perTask, totalTokens, tasksWithoutHistory, profile, estimatedClaudePercent, estimatedCodexPercent };
}

/**
 * Every completed real Codex run is its own calibration point: unlike Claude, Codex's
 * rollout reports a real, measured 5-hour quota percent (read-codex-session.ts), so
 * the (tokens, percent) pair between a run's start and end checkpoints (both written
 * by cli.ts around the run, see codexSessionCrossCheck) needs no manual /usage
 * transcription the way claude-calibration.ts's seeded points did. A pair only
 * counts when both readings are real (`percentUsedReported`, never
 * `percentUsedEstimated`) and the delta is positive - a zero or negative delta means
 * the 5-hour window reset between start and end, which is not a valid calibration
 * signal (same caveat docs/BENCHMARKS.md notes for manual readings).
 */
export function deriveCodexCalibrationPoints(history: readonly UsageCheckpoint[]): CalibrationPoint[] {
  const byRun = new Map<string, { start?: UsageCheckpoint; end?: UsageCheckpoint }>();

  for (const checkpoint of history) {
    if (checkpoint.scope !== "run" || checkpoint.engine !== "codex") {
      continue;
    }
    const entry = byRun.get(checkpoint.runId) ?? {};
    if (checkpoint.phase === "start") {
      entry.start = checkpoint;
    } else {
      entry.end = checkpoint;
    }
    byRun.set(checkpoint.runId, entry);
  }

  const points: CalibrationPoint[] = [];
  for (const { start, end } of byRun.values()) {
    if (!start || !end || start.percentUsedReported === null || end.percentUsedReported === null) {
      continue;
    }
    const percent = end.percentUsedReported - start.percentUsedReported;
    const tokens = totalTokensForCheckpoint(end);
    if (percent > 0 && tokens !== null && tokens > 0) {
      points.push({ tokens, percent });
    }
  }
  return points;
}

function profileFromCheckpoint(checkpoint: UsageCheckpoint): UsageEstimateProfile {
  return {
    engine: checkpoint.engine,
    model: checkpoint.schemaVersion === "1.1" ? checkpoint.model : null,
    reasoningEffort: checkpoint.schemaVersion === "1.1" ? checkpoint.reasoningEffort : null
  };
}

function sameProfile(left: UsageEstimateProfile, right: UsageEstimateProfile): boolean {
  return left.engine === right.engine && left.model === right.model && left.reasoningEffort === right.reasoningEffort;
}

function totalTokensForCheckpoint(checkpoint: UsageCheckpoint): number | null {
  const { inputUncachedTokens, cacheReadTokens, cacheWriteTokens, outputTokens } = checkpoint.tokens;

  if (inputUncachedTokens === null && cacheReadTokens === null && cacheWriteTokens === null && outputTokens === null) {
    return null;
  }

  return (inputUncachedTokens ?? 0) + (cacheReadTokens ?? 0) + (cacheWriteTokens ?? 0) + (outputTokens ?? 0);
}

function rangeFromSamples(samples: readonly number[]): TokenRange {
  const sorted = [...samples].sort((left, right) => left - right);

  return {
    low: sorted[0]!,
    median: median(sorted),
    high: sorted[sorted.length - 1]!
  };
}

function median(sorted: readonly number[]): number {
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1]! + sorted[middle]!) / 2 : sorted[middle]!;
}

function sum(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0);
}
