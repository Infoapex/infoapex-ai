import { sha256 } from "../manifest/normalize.js";
import type { CriterionCoverageEntry } from "../review/independent-review.js";
import type { IngestedFinding } from "../review/ingest-review.js";
import { SchemaRegistry } from "../schema/json-schema.js";
import type { RepairTask } from "./repair-task.js";

export interface RepairTaskCompilerInput {
  readonly runId: string;
  readonly graphVersion: number;
  readonly blockingFindings: readonly IngestedFinding[];
  readonly criterionCoverage: readonly CriterionCoverageEntry[];
  readonly maximumAttempts: number;
  readonly now?: string;
  readonly registry?: SchemaRegistry;
}

export interface SkippedRepairGroup {
  readonly findingIds: readonly string[];
  readonly reason: "no-verification-commands";
}

export interface RepairTaskCompilationResult {
  readonly tasks: readonly RepairTask[];
  readonly skipped: readonly SkippedRepairGroup[];
}

/**
 * Converts blocking, repair-eligible findings (src/review/ingest-review.ts)
 * into scoped repair tasks: explicit allowedPaths, verification commands
 * pulled from the criteria they affect, and a bounded attempt count.
 *
 * Findings whose scope overlaps are merged into a single task so two
 * independently-scheduled repair tasks never claim the same path (the
 * allowedPaths-must-not-overlap invariant for parallel tasks,
 * IMPLEMENTATION-PLAN.md §11.3). Ineligible findings are the caller's
 * concern (see ingest-review.ts) - this compiler only ever sees eligible
 * ones and still filters defensively.
 */
export function compileRepairTasks(input: RepairTaskCompilerInput): RepairTaskCompilationResult {
  const registry = input.registry ?? SchemaRegistry.load();
  const now = input.now ?? new Date().toISOString();
  const eligible = input.blockingFindings.filter((finding) => finding.eligibleForRepair);
  const groups = groupFindingsByOverlappingScope(eligible);
  const tasks: RepairTask[] = [];
  const skipped: SkippedRepairGroup[] = [];

  for (const group of groups) {
    const sortedFindings = [...group].sort((left, right) => left.id.localeCompare(right.id));
    const sourceFindingIds = sortedFindings.map((finding) => finding.id);
    const verify = resolveVerificationCommands(sortedFindings, input.criterionCoverage);

    if (verify.length === 0) {
      skipped.push({ findingIds: sourceFindingIds, reason: "no-verification-commands" });
      continue;
    }

    const task: RepairTask = {
      schemaVersion: "1.0",
      id: repairTaskId(sourceFindingIds),
      runId: input.runId,
      graphVersion: input.graphVersion,
      sourceFindingIds,
      allowedPaths: uniqueSorted(sortedFindings.flatMap(scopeOf)),
      forbiddenPaths: [],
      verify,
      dependsOn: [],
      maximumAttempts: input.maximumAttempts,
      status: "PENDING",
      createdAt: now
    };

    registry.assertValid("repair-task.schema.json", task);
    tasks.push(task);
  }

  tasks.sort((left, right) => left.sourceFindingIds[0]!.localeCompare(right.sourceFindingIds[0]!));

  return { tasks, skipped };
}

function scopeOf(finding: IngestedFinding): readonly string[] {
  return finding.recommendedScope && finding.recommendedScope.length > 0 ? finding.recommendedScope : finding.files;
}

function resolveVerificationCommands(
  findings: readonly IngestedFinding[],
  criterionCoverage: readonly CriterionCoverageEntry[]
): readonly string[] {
  const criterionIds = new Set(findings.flatMap((finding) => finding.criterionIds));
  const commands = criterionCoverage
    .filter((entry) => criterionIds.has(entry.criterionId))
    .flatMap((entry) => entry.commands);

  return uniqueSorted(commands);
}

function repairTaskId(sourceFindingIds: readonly string[]): string {
  return `REPAIR-${sha256(sourceFindingIds.join(",")).slice(0, 8).toUpperCase()}`;
}

function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}

/**
 * Union-find over shared scope paths: two findings land in the same repair
 * task the moment they name at least one identical path.
 */
function groupFindingsByOverlappingScope(findings: readonly IngestedFinding[]): readonly (readonly IngestedFinding[])[] {
  const parent = findings.map((_, index) => index);

  const find = (index: number): number => {
    while (parent[index] !== index) {
      parent[index] = parent[parent[index]!]!;
      index = parent[index]!;
    }

    return index;
  };

  const union = (left: number, right: number): void => {
    const leftRoot = find(left);
    const rightRoot = find(right);

    if (leftRoot !== rightRoot) {
      parent[leftRoot] = rightRoot;
    }
  };

  const pathOwner = new Map<string, number>();

  findings.forEach((finding, index) => {
    for (const path of scopeOf(finding)) {
      const owner = pathOwner.get(path);

      if (owner === undefined) {
        pathOwner.set(path, index);
      } else {
        union(owner, index);
      }
    }
  });

  const groups = new Map<number, IngestedFinding[]>();

  findings.forEach((finding, index) => {
    const root = find(index);
    const group = groups.get(root) ?? [];
    group.push(finding);
    groups.set(root, group);
  });

  return [...groups.values()];
}
