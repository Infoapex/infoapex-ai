import type { EngineUsage } from "../engines/engine-event.js";
import type { UsageTotals } from "../policy/usage-budget.js";
import { quotaEconomicVerdict, type QuotaUsage } from "./quota-usage.js";

export type UsageField = "inputUncachedTokens" | "cacheReadTokens" | "cacheWriteTokens" | "outputTokens" | "costUsd";
export type UsageCompleteness = "complete" | "partial" | "unavailable";
export type UsageAccountingMode = "incremental" | "cumulative";

export interface UsageSample {
  readonly sampleId: string;
  readonly seriesId: string;
  readonly sequence: number;
  readonly provider: "codex" | "claude" | "fake";
  readonly parserVersion: string;
  readonly accountingMode: UsageAccountingMode;
  readonly usage: EngineUsage;
}

export interface UsageAssessment {
  readonly completeness: UsageCompleteness;
  readonly economicVerdict: "comparable" | "inconclusive";
  readonly unknownFields: readonly UsageField[];
}

export interface NormalizedUsageReport extends UsageAssessment {
  readonly schemaVersion: "1.0";
  readonly sampleCount: number;
  readonly deduplicatedSampleCount: number;
  readonly parserVersions: readonly string[];
  readonly totals: Omit<UsageTotals, "agentInvocations"> & { readonly agentInvocations: number };
}

export class UsageAggregationError extends Error {
  constructor(
    readonly code: "DUPLICATE_SAMPLE_DRIFT" | "MIXED_ACCOUNTING_MODE",
    message: string
  ) {
    super(message);
    this.name = "UsageAggregationError";
  }
}

/**
 * Aggregates provider invocations without double-counting cumulative events.
 * Replayed samples are deduplicated by sampleId. Incremental samples are summed;
 * cumulative samples contribute only the highest sequence in their series.
 */
export function aggregateNormalizedUsage(samples: readonly UsageSample[]): NormalizedUsageReport {
  const unique = deduplicate(samples);
  const contributions: UsageSample[] = [];

  for (const series of groupBySeries(unique).values()) {
    const modes = new Set(series.map((sample) => sample.accountingMode));
    if (modes.size > 1) {
      throw new UsageAggregationError("MIXED_ACCOUNTING_MODE", `Series ${series[0]!.seriesId} mixes cumulative and incremental samples.`);
    }
    if (series[0]!.accountingMode === "cumulative") {
      contributions.push([...series].sort((left, right) => right.sequence - left.sequence)[0]!);
    } else {
      contributions.push(...series);
    }
  }

  const totals: UsageTotals = {
    agentInvocations: new Set(unique.map((sample) => sample.seriesId)).size,
    inputUncachedTokens: sumField(contributions, "inputUncachedTokens"),
    cacheReadTokens: sumField(contributions, "cacheReadTokens"),
    cacheWriteTokens: sumField(contributions, "cacheWriteTokens"),
    outputTokens: sumField(contributions, "outputTokens"),
    costUsd: sumField(contributions, "costUsd")
  };
  const assessment = assessUsageTotals(totals);

  return {
    schemaVersion: "1.0",
    sampleCount: samples.length,
    deduplicatedSampleCount: unique.length,
    parserVersions: [...new Set(unique.map((sample) => sample.parserVersion))].sort(),
    totals,
    ...assessment
  };
}

/**
 * `completeness`/`unknownFields` describe the 5 raw token/cost fields, unchanged.
 * `economicVerdict`, per the 2026-09-02 quota-percent decision, no longer depends on
 * `costUsd` at all - both accounts this project runs against are flat-rate ($20/mo)
 * subscriptions, where `costUsd` is frequently unavailable by design (see
 * docs/RELEASE-GATES.md, P2-B) and would never have reflected a real marginal cost
 * anyway. A run/task is "comparable" when its 5-hour quota-percent is known -
 * measured or estimated, see quota-usage.ts - regardless of whether `costUsd` is.
 * `quota` defaults to null for callers that don't yet compute it (e.g. the `fake`
 * engine, or any call site not updated yet), which correctly yields `inconclusive`
 * rather than silently reverting to the old cost-based comparability claim.
 */
export function assessUsageTotals(totals: UsageTotals | null, quota: QuotaUsage | null = null): UsageAssessment {
  if (totals === null) {
    return { completeness: "unavailable", economicVerdict: quotaEconomicVerdict(quota), unknownFields: FIELDS };
  }
  const unknownFields = FIELDS.filter((field) => totals[field] === null);
  const knownCount = FIELDS.length - unknownFields.length;
  return {
    completeness: knownCount === 0 ? "unavailable" : unknownFields.length === 0 ? "complete" : "partial",
    economicVerdict: quotaEconomicVerdict(quota),
    unknownFields
  };
}

const FIELDS: readonly UsageField[] = [
  "inputUncachedTokens",
  "cacheReadTokens",
  "cacheWriteTokens",
  "outputTokens",
  "costUsd"
];

function deduplicate(samples: readonly UsageSample[]): UsageSample[] {
  const unique = new Map<string, UsageSample>();
  for (const sample of samples) {
    const existing = unique.get(sample.sampleId);
    if (existing && JSON.stringify(existing) !== JSON.stringify(sample)) {
      throw new UsageAggregationError("DUPLICATE_SAMPLE_DRIFT", `Sample ${sample.sampleId} was replayed with different content.`);
    }
    unique.set(sample.sampleId, sample);
  }
  return [...unique.values()];
}

function groupBySeries(samples: readonly UsageSample[]): Map<string, UsageSample[]> {
  const groups = new Map<string, UsageSample[]>();
  for (const sample of samples) {
    const group = groups.get(sample.seriesId) ?? [];
    group.push(sample);
    groups.set(sample.seriesId, group);
  }
  return groups;
}

function sumField(samples: readonly UsageSample[], field: UsageField): number | null {
  if (samples.length === 0 || samples.some((sample) => sample.usage[field] === null)) {
    return null;
  }
  return samples.reduce((sum, sample) => sum + sample.usage[field]!, 0);
}
