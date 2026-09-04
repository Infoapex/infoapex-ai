import { createHash } from "node:crypto";

/** A small, dependency-free statistics implementation used by BENCH-07.
 * Randomness is deliberately seeded from a string so reports are identical
 * on every host (and do not depend on Math.random's implementation). */
export interface Distribution {
  readonly count: number;
  readonly min: number | null;
  readonly q1: number | null;
  readonly median: number | null;
  readonly q3: number | null;
  readonly p90: number | null;
  readonly p95: number | null;
  readonly max: number | null;
  readonly mean: number | null;
  readonly standardDeviation: number | null;
}

export interface ConfidenceInterval {
  readonly value: number | null;
  readonly lower: number | null;
  readonly upper: number | null;
  readonly method: "exact" | "bootstrap-percentile";
  readonly seed: string;
}

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function quantile(sorted: readonly number[], probability: number): number | null {
  if (sorted.length === 0) return null;
  const position = (sorted.length - 1) * probability;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sorted[lower] ?? null;
  const fraction = position - lower;
  return (sorted[lower]! * (1 - fraction)) + (sorted[upper]! * fraction);
}

export function describeDistribution(values: readonly (number | null | undefined)[]): Distribution {
  const sorted = values.filter(finite).sort((a, b) => a - b);
  if (sorted.length === 0) return { count: 0, min: null, q1: null, median: null, q3: null, p90: null, p95: null, max: null, mean: null, standardDeviation: null };
  const mean = sorted.reduce((sum, value) => sum + value, 0) / sorted.length;
  const variance = sorted.reduce((sum, value) => sum + ((value - mean) ** 2), 0) / sorted.length;
  return {
    count: sorted.length, min: sorted[0]!, q1: quantile(sorted, 0.25), median: quantile(sorted, 0.5),
    q3: quantile(sorted, 0.75), p90: quantile(sorted, 0.9), p95: quantile(sorted, 0.95), max: sorted.at(-1)!,
    mean, standardDeviation: Math.sqrt(variance)
  };
}

function seed32(seed: string | number): number {
  const digest = createHash("sha256").update(String(seed), "utf8").digest();
  return ((digest.readUInt32BE(0) || 1) >>> 0);
}

function nextRandom(state: { value: number }): number {
  // Mulberry32 is compact, deterministic, and avoids platform floating point
  // differences by deriving every draw from uint32 arithmetic.
  state.value = (state.value + 0x6d2b79f5) >>> 0;
  let t = state.value;
  t = Math.imul(t ^ (t >>> 15), t | 1) >>> 0;
  t ^= (t + Math.imul(t ^ (t >>> 7), t | 61)) >>> 0;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

export function bootstrapMeanConfidenceInterval(values: readonly (number | null | undefined)[], seed: string | number, options: { readonly samples?: number; readonly level?: number } = {}): ConfidenceInterval {
  const usable = values.filter(finite);
  const seedText = String(seed);
  if (usable.length === 0) return { value: null, lower: null, upper: null, method: "exact", seed: seedText };
  const value = usable.reduce((sum, item) => sum + item, 0) / usable.length;
  if (usable.length === 1) return { value, lower: value, upper: value, method: "exact", seed: seedText };
  const count = Math.max(1000, Math.floor(options.samples ?? 2000));
  const level = Math.min(0.999, Math.max(0.5, options.level ?? 0.95));
  const state = { value: seed32(seedText) };
  const means: number[] = [];
  for (let sample = 0; sample < count; sample += 1) {
    let total = 0;
    for (let index = 0; index < usable.length; index += 1) total += usable[Math.floor(nextRandom(state) * usable.length)]!;
    means.push(total / usable.length);
  }
  means.sort((a, b) => a - b);
  return { value, lower: quantile(means, (1 - level) / 2), upper: quantile(means, 1 - ((1 - level) / 2)), method: "bootstrap-percentile", seed: seedText };
}

export const bootstrapConfidenceInterval = bootstrapMeanConfidenceInterval;
export const descriptiveDistribution = describeDistribution;
