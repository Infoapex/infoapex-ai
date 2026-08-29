import { writeFileSync } from 'node:fs';
import type { WorkerManifestTask } from '../types.js';

export function writePlanMarkdown(params: {
  filePath: string;
  workerContractVersion?: '1.0' | '1.1';
  goal: string;
  tasks: WorkerManifestTask[];
  globalGates: string[];
  budgets: object;
}): void {
  const { filePath, workerContractVersion = '1.0', goal, tasks, globalGates, budgets } = params;
  const json = JSON.stringify({ workerContractVersion, goal, tasks, globalGates, budgets }, null, 2);
  const content = [
    '---',
    'status: accepted',
    '---',
    '',
    `# ${goal}`,
    '',
    '```ai-code-worker-plan',
    json,
    '```',
    '',
  ].join('\n');
  writeFileSync(filePath, content, 'utf-8');
}
