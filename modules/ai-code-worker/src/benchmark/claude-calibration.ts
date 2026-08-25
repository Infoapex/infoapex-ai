export interface CalibrationPoint {
  readonly tokens: number;
  readonly percent: number;
}

/** Seeded from docs/BENCHMARKS.md's "Rezumat consum per etapă" table (Phase 3
 *  stages 3-8, 2026-08-14 session) - each point is one real (Δ context tokens, Δ%5h)
 *  pair measured via manual /context + /usage checkpoints, on the Claude Pro plan.
 *  No account-level %5h/%weekly field exists in the local transcript (confirmed live,
 *  see docs/HANDOFF-BENCHMARK-TOOL-AND-PHASE-4.md), so this ratio can only be
 *  calibrated from real, user-reported /usage readings, not derived automatically.
 *  Recalibrate by appending fresh points as more real pairs accumulate - don't
 *  discard these until there is a clearly larger, more representative sample (the
 *  source doc itself notes the ~9.4-13.4k/pp spread trending down as the session got
 *  longer, i.e. this ratio is not perfectly constant even within one session). */
export const SEEDED_CLAUDE_CALIBRATION_POINTS: readonly CalibrationPoint[] = [
  { tokens: 52_800, percent: 4 }, // Stage 3: Repair task compiler
  { tokens: 46_800, percent: 4 }, // Stage 4: Bounded repair cycles in state machine
  { tokens: 28_200, percent: 3 }, // Stage 5: Graph revision semantics
  { tokens: 23_100, percent: 2 }, // Stage 6: Descendant invalidation
  { tokens: 58_800, percent: 5 }, // Stage 7: Recovery tests (process kill)
  { tokens: 23_400, percent: 2 } // Stage 8: Export: patch/branch/report
];

export interface ClaudePercentEstimate {
  readonly percent: number;
  readonly tokensPerPercentPoint: number;
  readonly sampleSize: number;
}

/** Median tokens-per-%5h-point ratio across calibration points - median rather than
 *  mean, to stay robust to any single outlier point (the estimator is explicitly a
 *  "learns over time" tool, not a precision model - don't over-engineer it before
 *  there is more real data). */
export function fitTokensPerPercentPoint(points: readonly CalibrationPoint[] = SEEDED_CLAUDE_CALIBRATION_POINTS): number {
  if (points.length === 0) {
    throw new Error("Cannot fit a tokens-per-percent-point ratio from zero calibration points.");
  }

  const ratios = points.map((point) => point.tokens / point.percent).sort((left, right) => left - right);
  return median(ratios);
}

/** Estimates %5h usage for a given context-token delta. This is ONLY ever an
 *  estimate - never conflate it with a real /usage reading. Callers must keep the
 *  two separate (see UsageCheckpoint.percentUsedReported vs percentUsedEstimated). */
export function estimateClaudePercentFromTokens(
  tokens: number,
  points: readonly CalibrationPoint[] = SEEDED_CLAUDE_CALIBRATION_POINTS
): ClaudePercentEstimate {
  const tokensPerPercentPoint = fitTokensPerPercentPoint(points);

  return {
    percent: tokens / tokensPerPercentPoint,
    tokensPerPercentPoint,
    sampleSize: points.length
  };
}

function median(sorted: readonly number[]): number {
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1]! + sorted[middle]!) / 2 : sorted[middle]!;
}
