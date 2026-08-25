import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { SchemaRegistry } from "../schema/json-schema.js";
import { resolveStateRoot } from "../state/state-root.js";

export type UsageCheckpointEngine = "fake" | "claude" | "codex";
export type UsageCheckpointScope = "run" | "task";
export type UsageCheckpointPhase = "start" | "end";
export type UsageCheckpointTaskKind = "contract" | "backend" | "frontend" | "database" | "docs" | "test" | "review" | "repair" | "other";
export type UsageCheckpointTaskRisk = "low" | "medium" | "high";

export interface UsageCheckpointTokens {
  readonly inputUncachedTokens: number | null;
  readonly cacheReadTokens: number | null;
  readonly cacheWriteTokens: number | null;
  readonly outputTokens: number | null;
  readonly costUsd: number | null;
}

export interface UsageCheckpoint {
  readonly schemaVersion: "1.0";
  readonly checkpointId: string;
  readonly runId: string;
  readonly taskId: string | null;
  readonly scope: UsageCheckpointScope;
  readonly engine: UsageCheckpointEngine;
  readonly phase: UsageCheckpointPhase;
  readonly createdAt: string;
  readonly taskKind: UsageCheckpointTaskKind | null;
  readonly taskRisk: UsageCheckpointTaskRisk | null;
  readonly tokens: UsageCheckpointTokens;
  readonly contextEstimateTokens: number | null;
  readonly percentUsedReported: number | null;
  readonly percentUsedEstimated: number | null;
}

export interface AppendUsageCheckpointInput {
  readonly checkpointId: string;
  readonly runId: string;
  readonly taskId?: string | null;
  readonly scope: UsageCheckpointScope;
  readonly engine: UsageCheckpointEngine;
  readonly phase: UsageCheckpointPhase;
  readonly createdAt: string;
  readonly taskKind?: UsageCheckpointTaskKind | null;
  readonly taskRisk?: UsageCheckpointTaskRisk | null;
  readonly tokens?: Partial<UsageCheckpointTokens>;
  readonly contextEstimateTokens?: number | null;
  readonly percentUsedReported?: number | null;
  readonly percentUsedEstimated?: number | null;
}

export interface UsageCheckpointLogReadResult {
  readonly checkpoints: readonly UsageCheckpoint[];
  readonly ignoredTailLines: readonly string[];
}

/**
 * Append-only JSONL log of usage checkpoints, mirroring the shape (and the
 * corrupt-tail tolerance) of persistence/event-log.ts's EventLog, but without its
 * strict per-run sequence-gap invariant: checkpoints are cross-run history feeding
 * the estimator (estimate.ts), not a recovery-critical stream for a single run.
 */
export class UsageCheckpointLog {
  constructor(
    readonly path: string,
    private readonly registry = SchemaRegistry.load()
  ) {}

  append(input: AppendUsageCheckpointInput): UsageCheckpoint {
    const checkpoint: UsageCheckpoint = {
      schemaVersion: "1.0",
      checkpointId: input.checkpointId,
      runId: input.runId,
      taskId: input.taskId ?? null,
      scope: input.scope,
      engine: input.engine,
      phase: input.phase,
      createdAt: input.createdAt,
      taskKind: input.taskKind ?? null,
      taskRisk: input.taskRisk ?? null,
      tokens: {
        inputUncachedTokens: input.tokens?.inputUncachedTokens ?? null,
        cacheReadTokens: input.tokens?.cacheReadTokens ?? null,
        cacheWriteTokens: input.tokens?.cacheWriteTokens ?? null,
        outputTokens: input.tokens?.outputTokens ?? null,
        costUsd: input.tokens?.costUsd ?? null
      },
      contextEstimateTokens: input.contextEstimateTokens ?? null,
      percentUsedReported: input.percentUsedReported ?? null,
      percentUsedEstimated: input.percentUsedEstimated ?? null
    };

    this.registry.assertValid("usage-checkpoint.schema.json", checkpoint);
    ensureDirectory(dirname(this.path));
    writeFileSync(this.path, `${JSON.stringify(checkpoint)}\n`, { flag: "a", encoding: "utf8" });

    return checkpoint;
  }

  read(): UsageCheckpointLogReadResult {
    if (!existsSync(this.path)) {
      return { checkpoints: [], ignoredTailLines: [] };
    }

    const content = readFileSync(this.path, "utf8");
    const lines = content.split(/\r?\n/);
    const checkpoints: UsageCheckpoint[] = [];
    const ignoredTailLines: string[] = [];

    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];

      if (!line) {
        continue;
      }

      try {
        const parsed = JSON.parse(line) as UsageCheckpoint;
        this.registry.assertValid("usage-checkpoint.schema.json", parsed);
        checkpoints.push(parsed);
      } catch (error) {
        if (isLastNonEmptyLine(lines, index)) {
          ignoredTailLines.push(line);
          break;
        }

        throw error;
      }
    }

    return { checkpoints, ignoredTailLines };
  }
}

/** Cross-run, per-repository checkpoint history lives under the resolved state root
 *  (same base as `runs/`), not inside a single run's directory - the estimator needs
 *  to see checkpoints from prior runs, not just the current one. */
export function resolveUsageCheckpointLogPath(repositoryPath: string): string {
  const stateRoot = resolveStateRoot({ repoRoot: repositoryPath });
  return join(stateRoot.path, "benchmarks", "usage-checkpoints.jsonl");
}

function isLastNonEmptyLine(lines: readonly string[], index: number): boolean {
  return lines.slice(index + 1).every((line) => !line);
}

function ensureDirectory(path: string): void {
  mkdirSync(path, { recursive: true });
}
