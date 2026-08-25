import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { writePlanMarkdown } from '../../src/plan-file/write-plan-markdown.js';
import { readPlanMarkdown } from '../../src/plan-file/read-plan-markdown.js';
import type { WorkerManifestTask } from '../../src/types.js';

const testTasks: WorkerManifestTask[] = [
  {
    id: 'TASK-A',
    kind: 'contract',
    role: 'Define the schema.',
    dependsOn: [],
    requiredInputs: ['docs/PHASE-0.md'],
    allowedPaths: ['schemas/'],
    forbiddenPaths: ['src/'],
    expectedArtifacts: ['schemas/plan.schema.json'],
    acceptanceCriteria: ['Schema exists and is valid.', 'additionalProperties is false.'],
    verify: ['verify-schema'],
    concurrencyKeys: ['schemas'],
    risk: 'low',
  },
  {
    id: 'TASK-B',
    kind: 'implementation',
    role: 'Write the validator.',
    dependsOn: ['TASK-A'],
    requiredInputs: ['schemas/plan.schema.json'],
    allowedPaths: ['src/'],
    forbiddenPaths: ['schemas/'],
    expectedArtifacts: ['src/schema-validate.ts'],
    acceptanceCriteria: ['Validator compiles.'],
    verify: ['build', 'test-schema-validate'],
    concurrencyKeys: ['src'],
    risk: 'medium',
  },
];

const testGlobalGates = ['json-parse', 'build'];

const testBudgets = {
  maximumParallelWriters: 2,
  maximumRepairCycles: 3,
  maximumTaskMinutes: 30,
  maximumRunMinutes: 90,
  maximumRunCostUsd: 5.0,
};

test('round-trips goal, tasks, globalGates, and budgets through write and read', () => {
  const tmpDir = mkdtempSync(join(tmpdir(), 'plan-markdown-test-'));
  const filePath = join(tmpDir, 'test-plan.md');

  try {
    writePlanMarkdown({
      filePath,
      goal: 'Produce the plan schema and validator.',
      tasks: testTasks,
      globalGates: testGlobalGates,
      budgets: testBudgets,
    });

    const result = readPlanMarkdown(filePath);

    assert.strictEqual(result.status, 'accepted');
    assert.strictEqual(result.goal, 'Produce the plan schema and validator.');
    assert.deepStrictEqual(result.tasks, testTasks);
    assert.deepStrictEqual(result.globalGates, testGlobalGates);
    assert.deepStrictEqual(result.budgets, testBudgets);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});
