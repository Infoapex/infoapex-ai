import { test } from 'node:test';
import assert from 'node:assert/strict';
import { projectToWorkerV1 } from '../../src/projection/project-to-worker-v1.js';
import { validateWorkerTaskExport } from '../../src/projection/validate-worker-export.js';
import type { Plan } from '../../src/types.js';

const testPlan: Plan = {
  goal: 'Test plan goal',
  tasks: [
    {
      id: 'TASK-001',
      goal: 'First task with execution profile',
      acceptanceCriteria: [
        { criterionId: 'AC-001', text: 'Output must be valid JSON.' },
        { criterionId: 'AC-002', text: 'No errors in stderr.' },
      ],
      gates: [
        { gateId: 'G-001', command: 'verify-schema', evidenceContract: 'Exit code 0.' },
      ],
      dependsOn: [],
      scope: { allowedPaths: ['src/'], forbiddenPaths: ['docs/'] },
      requiredInputs: [{ kind: 'file', ref: 'docs/PHASE-0.md' }],
      executionProfile: 'long-running',
    },
    {
      id: 'TASK-002',
      goal: 'Second task without execution profile',
      acceptanceCriteria: [
        { criterionId: 'AC-003', text: 'File exists.' },
      ],
      gates: [
        { gateId: 'G-002', command: 'build', evidenceContract: 'Build succeeds.' },
        { gateId: 'G-003', command: 'test', evidenceContract: 'All tests pass.' },
      ],
      dependsOn: ['TASK-001'],
      scope: { allowedPaths: ['tests/'], forbiddenPaths: [] },
      requiredInputs: [],
    },
  ],
};

test('projects acceptanceCriteria to text strings and gates to command strings', () => {
  const { manifestTasks } = projectToWorkerV1(testPlan);

  assert.deepStrictEqual(manifestTasks[0].acceptanceCriteria, [
    'Output must be valid JSON.',
    'No errors in stderr.',
  ]);
  assert.deepStrictEqual(manifestTasks[0].verify, ['verify-schema']);

  assert.deepStrictEqual(manifestTasks[1].acceptanceCriteria, ['File exists.']);
  assert.deepStrictEqual(manifestTasks[1].verify, ['build', 'test']);
});

test('executionProfile passes through on task that has it, absent on task that does not', () => {
  const { manifestTasks } = projectToWorkerV1(testPlan);

  assert.strictEqual(manifestTasks[0].executionProfile, 'long-running');
  assert.strictEqual('executionProfile' in manifestTasks[1], false);
});

test('projectionWarnings has exactly one entry per task listing expected lostFields', () => {
  const { projectionWarnings } = projectToWorkerV1(testPlan);

  assert.strictEqual(projectionWarnings.length, 2);

  assert.strictEqual(projectionWarnings[0].taskId, 'TASK-001');
  assert.deepStrictEqual(projectionWarnings[0].lostFields, [
    'acceptanceCriteria[0].criterionId',
    'acceptanceCriteria[1].criterionId',
    'gates[0].gateId',
    'gates[0].evidenceContract',
  ]);

  assert.strictEqual(projectionWarnings[1].taskId, 'TASK-002');
  assert.deepStrictEqual(projectionWarnings[1].lostFields, [
    'acceptanceCriteria[0].criterionId',
    'gates[0].gateId',
    'gates[0].evidenceContract',
    'gates[1].gateId',
    'gates[1].evidenceContract',
  ]);
});

test('globalGates is empty for Phase 1', () => {
  const { globalGates } = projectToWorkerV1(testPlan);
  assert.deepStrictEqual(globalGates, []);
});

test('requiredInputs are projected to ref strings', () => {
  const { manifestTasks } = projectToWorkerV1(testPlan);
  assert.deepStrictEqual(manifestTasks[0].requiredInputs, ['docs/PHASE-0.md']);
  assert.deepStrictEqual(manifestTasks[1].requiredInputs, []);
});

test('worker export rejects task ids that the worker manifest schema cannot accept', () => {
  const lowerCasePlan: Plan = {
    ...testPlan,
    tasks: [{ ...testPlan.tasks[0], id: 'task-001' }]
  };

  const { manifestTasks } = projectToWorkerV1(lowerCasePlan);
  assert.deepStrictEqual(validateWorkerTaskExport(manifestTasks), [
    'task-001: task id must match ^[A-Z0-9][A-Z0-9._-]*$'
  ]);
});
