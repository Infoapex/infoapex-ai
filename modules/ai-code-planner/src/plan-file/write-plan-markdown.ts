import { writeFileSync } from 'node:fs';
import type { WorkerManifestTask } from '../types.js';

export function writePlanMarkdown(params: {
  filePath: string;
  goal: string;
  tasks: WorkerManifestTask[];
  globalGates: string[];
  budgets: object;
}): void {
  const { filePath, goal, tasks, globalGates, budgets } = params;
  const json = JSON.stringify({ goal, tasks, globalGates, budgets }, null, 2);
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
