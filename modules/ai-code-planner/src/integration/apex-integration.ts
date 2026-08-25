import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

interface ApexConfig {
  readonly schemaVersion: '1.0';
  readonly mode: 'independent' | 'integrated';
  readonly handoffRoot: string;
  readonly planner?: { readonly enabled?: boolean };
}

export function publishPlannerHandoff(input: {
  repositoryPath: string;
  planPath: string;
  runId: string;
  goal: string;
  tasks: readonly { id: string; executionProfile?: string }[];
}): string | null {
  const config = readConfig(input.repositoryPath);
  if (!config || config.planner?.enabled === false) return null;
  const output = join(resolveHandoffRoot(input.repositoryPath, config.handoffRoot), input.runId, 'planner-to-worker.json');
  const handoff = {
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
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, `${JSON.stringify(handoff, null, 2)}\n`, 'utf8');
  return output;
}

export function readWorkerFeedback(repositoryPath: string, runId: string): unknown {
  const config = readConfig(repositoryPath);
  if (!config) throw new Error('infoapex-ai integration is not enabled for this repository.');
  const path = join(resolveHandoffRoot(repositoryPath, config.handoffRoot), runId, 'worker-to-planner.json');
  if (!existsSync(path)) throw new Error(`Worker feedback not found for run ${runId}.`);
  return JSON.parse(readFileSync(path, 'utf8'));
}

function readConfig(repositoryPath: string): ApexConfig | null {
  const path = join(repositoryPath, '.infoapex-ai', 'config.json');
  if (!existsSync(path)) return null;
  const config = JSON.parse(readFileSync(path, 'utf8')) as ApexConfig;
  return config.schemaVersion === '1.0' && config.mode === 'integrated' ? config : null;
}

function resolveHandoffRoot(repositoryPath: string, configured: string): string {
  return isAbsolute(configured) ? configured : resolve(repositoryPath, configured);
}
