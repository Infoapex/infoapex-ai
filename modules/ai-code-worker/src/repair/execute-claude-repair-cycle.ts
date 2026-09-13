import { ClaudeCliAdapter, type ClaudeCliAdapterConfig } from "../engines/claude-cli.js";
import { claudeAdapterConfigFromProject, claudeConfig } from "../run/claude-run.js";
import type { ProjectConfig } from "../config/project-config.js";
import { SchemaRegistry } from "../schema/json-schema.js";
import { createRealEngineRepairExecutor, type RealEngineRepairExecutorOptions } from "./execute-real-engine-repair-cycle.js";
import type { RepairCycleExecutor } from "./repair-cycle.js";

export interface CreateClaudeRepairExecutorOptions
  extends Omit<RealEngineRepairExecutorOptions, "engineName" | "adapter"> {
  readonly projectConfig?: ProjectConfig | null;
  readonly adapterConfig?: Partial<ClaudeCliAdapterConfig>;
  readonly registry?: SchemaRegistry;
}

/**
 * Wires createRealEngineRepairExecutor to a real ClaudeCliAdapter, built the
 * same way runClaude does (claudeConfig + claudeAdapterConfigFromProject,
 * now exported from claude-run.ts for exactly this reuse) - so a repair
 * attempt authenticates and configures identically to the original task
 * that failed review.
 */
export function createClaudeRepairExecutor(options: CreateClaudeRepairExecutorOptions): RepairCycleExecutor {
  const registry = options.registry ?? SchemaRegistry.load();
  const adapter = new ClaudeCliAdapter(
    claudeConfig({
      ...claudeAdapterConfigFromProject(options.projectConfig ?? null),
      ...options.adapterConfig,
      ...(options.processRunner ? { processRunner: options.processRunner } : {})
    }),
    registry
  );

  return createRealEngineRepairExecutor({
    ...options,
    engineName: "claude",
    adapter
  });
}
