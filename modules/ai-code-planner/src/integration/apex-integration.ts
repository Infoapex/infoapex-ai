import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { validateAgainstSchema } from '../schema-validate.js';
import {
  assertSafeRunId,
  resolveIntegrationConfigForRead,
  resolveHandoffFileForRead,
  resolveHandoffFileForWrite,
  validateConfiguredHandoffRoot,
  writeJsonCreateNew,
} from './handoff-paths.js';

interface ApexConfig {
  readonly schemaVersion: '1.0';
  readonly mode: 'independent' | 'integrated';
  readonly handoffRoot: string;
  readonly planner?: { readonly enabled?: boolean };
  readonly worker?: { readonly enabled?: boolean };
}

interface ApexHandoff {
  readonly schemaVersion: '1.0';
  readonly handoffId: string;
  readonly direction: 'planner-to-worker' | 'worker-to-planner';
  readonly createdAt: string;
  readonly runId: string;
  readonly payload: Record<string, unknown>;
}

export function publishPlannerHandoff(input: {
  repositoryPath: string;
  planPath: string;
  runId: string;
  goal: string;
  tasks: readonly { id: string; executionProfile?: string }[];
}): string | null {
  assertSafeRunId(input.runId);
  const config = readConfig(input.repositoryPath);
  if (!config || config.planner?.enabled === false) return null;
  const handoff: ApexHandoff = {
    schemaVersion: '1.0',
    handoffId: randomUUID(),
    direction: 'planner-to-worker',
    createdAt: new Date().toISOString(),
    runId: input.runId,
    payload: {
      planPath: input.planPath,
      goal: input.goal,
      tasks: input.tasks.map(task => ({ id: task.id, ...(task.executionProfile ? { executionProfile: task.executionProfile } : {}) }))
    }
  };
  assertValidHandoff(handoff);
  const output = resolveHandoffFileForWrite(
    input.repositoryPath,
    config.handoffRoot,
    input.runId,
    'planner-to-worker.json',
  );
  writeJsonCreateNew(output, handoff);
  return output;
}

export function readWorkerFeedback(repositoryPath: string, runId: string): unknown {
  assertSafeRunId(runId);
  const config = readConfig(repositoryPath);
  if (!config) throw new Error('infoapex-ai integration is not enabled for this repository.');
  const path = resolveHandoffFileForRead(repositoryPath, config.handoffRoot, runId, 'worker-to-planner.json');
  if (!existsSync(path)) throw new Error(`Worker feedback not found for run ${runId}.`);
  const handoff = parseJson(readFileSync(path, 'utf8'), `worker feedback at ${path}`);
  assertValidHandoff(handoff);
  if (handoff.direction !== 'worker-to-planner') {
    throw new Error(`Worker feedback direction mismatch: expected worker-to-planner, got ${handoff.direction}.`);
  }
  if (handoff.runId !== runId) {
    throw new Error(`Worker feedback runId mismatch: expected ${runId}, got ${handoff.runId}.`);
  }
  return handoff;
}

function readConfig(repositoryPath: string): ApexConfig | null {
  const path = resolveIntegrationConfigForRead(repositoryPath);
  if (!existsSync(path)) return null;
  const raw = parseJson(readFileSync(path, 'utf8'), `integration config at ${path}`);
  const validation = validateAgainstSchema<ApexConfig>('integration-config.schema.json', raw);
  if (!validation.valid) {
    throw new Error(`Invalid infoapex-ai integration config: ${validation.errors.join('; ')}`);
  }
  validateConfiguredHandoffRoot(repositoryPath, validation.data.handoffRoot);
  return validation.data.mode === 'integrated' ? validation.data : null;
}

function assertValidHandoff(value: unknown): asserts value is ApexHandoff {
  const validation = validateAgainstSchema<ApexHandoff>('handoff.schema.json', value);
  if (!validation.valid) {
    throw new Error(`Invalid infoapex-ai handoff: ${validation.errors.join('; ')}`);
  }
}

function parseJson(source: string, label: string): unknown {
  try {
    return JSON.parse(source) as unknown;
  } catch (error) {
    throw new Error(`Invalid ${label} JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}
