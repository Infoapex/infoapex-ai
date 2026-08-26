import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { SchemaRegistry } from "../schema/json-schema.js";
import {
  assertSafeRunId,
  resolveIntegrationConfigForRead,
  resolveHandoffFileForRead,
  resolveHandoffFileForWrite,
  resolveHandoffRootForRead,
  validateConfiguredHandoffRoot,
  writeJsonCreateNew
} from "./handoff-paths.js";

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

interface ApexHandoff {
  readonly schemaVersion: "1.0";
  readonly handoffId: string;
  readonly direction: "planner-to-worker" | "worker-to-planner";
  readonly createdAt: string;
  readonly runId: string;
  readonly payload: Record<string, unknown>;
}

let integrationSchemaRegistry: SchemaRegistry | null = null;

export function readApexIntegrationConfig(repositoryPath: string): ApexIntegrationConfig | null {
  const path = resolveIntegrationConfigForRead(repositoryPath);
  if (!existsSync(path)) return null;
  const config = parseJson(readFileSync(path, "utf8"), `integration config at ${path}`);
  assertValid("integration-config.schema.json", config);
  validateConfiguredHandoffRoot(repositoryPath, config.handoffRoot);
  if (config.mode !== "integrated" || config.worker?.enabled === false) return null;
  return config;
}

export function publishWorkerFeedback(repositoryPath: string, input: WorkerFeedbackInput): string | null {
  if (!input.runId) return null;
  assertSafeRunId(input.runId);
  if (input.channelRunId !== undefined) assertSafeRunId(input.channelRunId);
  const config = readApexIntegrationConfig(repositoryPath);
  if (!config) return null;
  const channelRunId = input.channelRunId ?? input.runId;
  const document: ApexHandoff = {
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
      ...(input.usageTotals !== undefined ? { usageTotals: input.usageTotals } : {}),
      ...(input.routing !== undefined ? { routing: input.routing } : {})
    }
  };
  assertValid("handoff.schema.json", document);
  const output = resolveHandoffFileForWrite(repositoryPath, config.handoffRoot, channelRunId, "worker-to-planner.json");
  writeJsonCreateNew(output, document);
  return output;
}

export function findPlannerHandoffRunId(repositoryPath: string, planPath: string): string | null {
  const config = readApexIntegrationConfig(repositoryPath);
  if (!config) return null;
  const root = resolveHandoffRootForRead(repositoryPath, config.handoffRoot);
  if (!existsSync(root)) return null;
  const normalizedPlan = resolve(repositoryPath, planPath).replaceAll("\\", "/");
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    try {
      assertSafeRunId(entry.name);
      const path = resolveHandoffFileForRead(repositoryPath, config.handoffRoot, entry.name, "planner-to-worker.json");
      if (!existsSync(path)) continue;
      const document = parseJson(readFileSync(path, "utf8"), `planner handoff at ${path}`);
      assertValid("handoff.schema.json", document);
      if (document.direction !== "planner-to-worker" || document.runId !== entry.name) continue;
      const publishedPlanPath = document.payload.planPath;
      if (typeof publishedPlanPath === "string" && resolve(repositoryPath, publishedPlanPath).replaceAll("\\", "/") === normalizedPlan) {
        return entry.name;
      }
    } catch {
      // Ignore malformed optional handoffs; standalone execution must remain available.
    }
  }
  return null;
}

function assertValid(schemaName: string, value: unknown): asserts value is ApexIntegrationConfig & ApexHandoff {
  integrationSchemaRegistry ??= SchemaRegistry.load();
  integrationSchemaRegistry.assertValid(schemaName, value);
}

function parseJson(source: string, label: string): unknown {
  try {
    return JSON.parse(source) as unknown;
  } catch (error) {
    throw new Error(`Invalid ${label} JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}
