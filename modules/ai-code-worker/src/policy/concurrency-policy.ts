import { normalizePolicyPath } from "./scope-policy.js";

export interface ConcurrencyScope {
  readonly taskId: string;
  readonly allowedPaths: readonly string[];
  readonly concurrencyKeys: readonly string[];
}

export interface OverlapResult {
  readonly compatible: boolean;
  readonly reason: "concurrencyKeyOverlap" | "pathOverlap" | null;
  readonly detail: string | null;
}

/**
 * Determines whether two tasks are safe to run as concurrent writers: neither shares a
 * concurrencyKey, and no pair of their allowedPaths patterns could ever match the same
 * concrete file. Ambiguous glob comparisons fail toward declaring overlap (serializing
 * two tasks that could have run in parallel is safe; letting two writers touch the same
 * file concurrently is not).
 */
export function tasksOverlap(a: ConcurrencyScope, b: ConcurrencyScope): OverlapResult {
  const sharedKey = a.concurrencyKeys.find((key) => b.concurrencyKeys.includes(key));
  if (sharedKey) {
    return {
      compatible: false,
      reason: "concurrencyKeyOverlap",
      detail: `Tasks ${a.taskId} and ${b.taskId} share concurrencyKey "${sharedKey}".`
    };
  }

  for (const patternA of a.allowedPaths) {
    for (const patternB of b.allowedPaths) {
      if (patternsCanOverlap(patternA, patternB)) {
        return {
          compatible: false,
          reason: "pathOverlap",
          detail: `Tasks ${a.taskId} and ${b.taskId} have overlapping allowedPaths: "${patternA}" vs "${patternB}".`
        };
      }
    }
  }

  return { compatible: true, reason: null, detail: null };
}

/**
 * Greedily partitions a set of ready task IDs (already in deterministic topological
 * order) into waves of mutually-compatible tasks, each wave capped at
 * maximumParallelWriters. Iterating readyTaskIds in a fixed order and always placing a
 * task into the first compatible wave (else opening a new one) keeps the result
 * deterministic for a given input.
 */
export function partitionIntoWaves(
  readyTaskIds: readonly string[],
  scopesById: ReadonlyMap<string, ConcurrencyScope>,
  maximumParallelWriters: number
): string[][] {
  const cap = Math.max(1, Math.floor(maximumParallelWriters) || 1);
  const waves: string[][] = [];

  for (const taskId of readyTaskIds) {
    const scope = scopesById.get(taskId);
    if (!scope) {
      continue;
    }

    let placed = false;
    for (const wave of waves) {
      if (wave.length >= cap) {
        continue;
      }

      const compatibleWithWave = wave.every((existingId) => tasksOverlap(scope, scopesById.get(existingId)!).compatible);
      if (compatibleWithWave) {
        wave.push(taskId);
        placed = true;
        break;
      }
    }

    if (!placed) {
      waves.push([taskId]);
    }
  }

  return waves;
}

function patternsCanOverlap(a: string, b: string): boolean {
  const na = normalizePolicyPath(a);
  const nb = normalizePolicyPath(b);

  if (!na || !nb) {
    return true;
  }

  if (na === "**" || nb === "**" || na === nb) {
    return true;
  }

  const aIsGlob = na.includes("*");
  const bIsGlob = nb.includes("*");

  if (!aIsGlob && !bIsGlob) {
    return na === nb;
  }

  const prefixA = patternDirPrefix(na);
  const prefixB = patternDirPrefix(nb);

  return isAncestorOrSame(prefixA, prefixB);
}

function patternDirPrefix(pattern: string): string {
  const segments = pattern.split("/");
  const wildcardIndex = segments.findIndex((segment) => segment.includes("*"));

  if (wildcardIndex === -1) {
    return pattern;
  }

  return segments.slice(0, wildcardIndex).join("/");
}

function isAncestorOrSame(prefixA: string, prefixB: string): boolean {
  return prefixA === prefixB || prefixA.startsWith(`${prefixB}/`) || prefixB.startsWith(`${prefixA}/`);
}
