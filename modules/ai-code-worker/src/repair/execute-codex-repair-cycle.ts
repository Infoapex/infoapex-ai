import { CodexCliAdapter, type CodexCliAdapterConfig } from "../engines/codex-cli.js";
import { codexAdapterConfigFromProject, codexConfig } from "../run/codex-run.js";
import type { ProjectConfig } from "../config/project-config.js";
import { SchemaRegistry } from "../schema/json-schema.js";
import { createRealEngineRepairExecutor, type RealEngineRepairExecutorOptions } from "./execute-real-engine-repair-cycle.js";
import type { RepairCycleExecutor } from "./repair-cycle.js";

export interface CreateCodexRepairExecutorOptions
  extends Omit<RealEngineRepairExecutorOptions, "engineName" | "adapter"> {
  readonly projectConfig?: ProjectConfig | null;
  readonly adapterConfig?: Partial<CodexCliAdapterConfig>;
  readonly registry?: SchemaRegistry;
}

/**
 * Wires createRealEngineRepairExecutor to a real CodexCliAdapter, built the
 * same way runCodex does (codexConfig + codexAdapterConfigFromProject, now
 * exported from codex-run.ts for exactly this reuse) - so a repair attempt
 * authenticates and configures identically to the original task that failed
 * review.
 */
export function createCodexRepairExecutor(options: CreateCodexRepairExecutorOptions): RepairCycleExecutor {
  const registry = options.registry ?? SchemaRegistry.load();
  const adapter = new CodexCliAdapter(
    codexConfig({
      ...codexAdapterConfigFromProject(options.projectConfig ?? null),
      ...options.adapterConfig,
      ...(options.processRunner ? { processRunner: options.processRunner } : {})
    }),
    registry
  );

  return createRealEngineRepairExecutor({
    ...options,
    engineName: "codex",
    adapter
  });
}
