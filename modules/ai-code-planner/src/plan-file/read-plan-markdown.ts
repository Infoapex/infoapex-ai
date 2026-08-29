import { readFileSync } from 'node:fs';
import type { WorkerManifestTask } from '../types.js';

export function readPlanMarkdown(filePath: string): {
  status: string;
  workerContractVersion: '1.0' | '1.1';
  goal: string;
  tasks: WorkerManifestTask[];
  globalGates: string[];
  budgets: object;
} {
  const content = readFileSync(filePath, 'utf-8');

  const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---/);
  let status = '';
  if (frontmatterMatch) {
    const statusMatch = frontmatterMatch[1].match(/^status:\s*(.+)$/m);
    if (statusMatch) {
      status = statusMatch[1].trim();
    }
  }

  const codeBlockMatch = content.match(/```ai-code-worker-plan\n([\s\S]*?)\n```/);
  if (!codeBlockMatch) {
    throw new Error(`No ai-code-worker-plan code block found in ${filePath}`);
  }

  const parsed = JSON.parse(codeBlockMatch[1]) as {
    workerContractVersion?: '1.0' | '1.1';
    goal: string;
    tasks: WorkerManifestTask[];
    globalGates: string[];
    budgets: object;
  };

  return {
    status,
    workerContractVersion: parsed.workerContractVersion ?? '1.0',
    goal: parsed.goal,
    tasks: parsed.tasks,
    globalGates: parsed.globalGates,
    budgets: parsed.budgets,
  };
}
