import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";

export interface ApexIntegrationConfig {
  readonly schemaVersion: "1.0";
  readonly mode: "independent" | "integrated";
  readonly handoffRoot: string;
  readonly planner?: { readonly enabled?: boolean };
  readonly worker?: { readonly enabled?: boolean };
}

export interface WorkerFeedbackInput {
  readonly runId: string | null;
  readonly status: string;
  readonly executedTasks: readonly string[];
  readonly findings: readonly unknown[];
  readonly engineProvenance?: unknown;
  readonly taskCommits?: unknown;
  readonly usageTotals?: unknown;
  readonly routing?: unknown;
  readonly channelRunId?: string;
}

export function readApexIntegrationConfig(repositoryPath: string): ApexIntegrationConfig | null {
  const path = join(repositoryPath, ".ai-code-apex", "config.json");
  if (!existsSync(path)) return null;
  const config = JSON.parse(readFileSync(path, "utf8")) as ApexIntegrationConfig;
  if (config.schemaVersion !== "1.0" || config.mode !== "integrated" || config.worker?.enabled === false) return null;
  return config;
}

export function publishWorkerFeedback(repositoryPath: string, input: WorkerFeedbackInput): string | null {
  const config = readApexIntegrationConfig(repositoryPath);
  if (!config || !input.runId) return null;
  const channelRunId = input.channelRunId ?? input.runId;
  const output = join(resolveHandoffRoot(repositoryPath, config.handoffRoot), channelRunId, "worker-to-planner.json");
  const document = {
    schemaVersion: "1.0",
    handoffId: randomUUID(),
    direction: "worker-to-planner",
    createdAt: new Date().toISOString(),
    runId: channelRunId,
    payload: {
      status: input.status,
      workerRunId: input.runId,
      executedTasks: input.executedTasks,
      findings: input.findings,
      ...(input.engineProvenance !== undefined ? { engineProvenance: input.engineProvenance } : {}),
      ...(input.taskCommits !== undefined ? { taskCommits: input.taskCommits } : {}),
      ...(input.usageTotals !== undefined ? { usageTotals: input.usageTotals } : {})
      ,...(input.routing !== undefined ? { routing: input.routing } : {})
    }
  };
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, `${JSON.stringify(document, null, 2)}\n`, "utf8");
  return output;
}

export function resolveHandoffRoot(repositoryPath: string, configured: string): string {
  return isAbsolute(configured) ? configured : resolve(repositoryPath, configured);
}

export function findPlannerHandoffRunId(repositoryPath: string, planPath: string): string | null {
  const config = readApexIntegrationConfig(repositoryPath);
  if (!config) return null;
  const root = resolveHandoffRoot(repositoryPath, config.handoffRoot);
  if (!existsSync(root)) return null;
  const normalizedPlan = resolve(repositoryPath, planPath).replaceAll("\\", "/");
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const path = join(root, entry.name, "planner-to-worker.json");
    if (!existsSync(path)) continue;
    try {
      const document = JSON.parse(readFileSync(path, "utf8")) as { payload?: { planPath?: string } };
      if (typeof document.payload?.planPath === "string" && resolve(repositoryPath, document.payload.planPath).replaceAll("\\", "/") === normalizedPlan) {
        return entry.name;
      }
    } catch {
      // Ignore malformed optional handoffs; standalone execution must remain available.
    }
  }
  return null;
}
