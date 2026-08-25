import { test } from 'node:test';
import assert from 'node:assert/strict';
import { contextForPrompt } from '../../src/context/types.js';
import { applyRoutingProposal } from '../../src/routing/propose-routing.js';
import { replanFromWorkerFeedback } from '../../src/replan/replan-from-worker.js';
import { projectToWorkerV1 } from '../../src/projection/project-to-worker-v1.js';
import { validateWorkerTaskExport } from '../../src/projection/validate-worker-export.js';
import type { Plan } from '../../src/types.js';

const plan: Plan = {
  goal: 'Implement a backend change and its tests',
  tasks: [
    {
      id: 'API-01',
      goal: 'Update the backend API contract',
      acceptanceCriteria: [{ criterionId: 'AC-1', text: 'Contract remains valid.' }],
      gates: [{ gateId: 'G-1', command: 'npm test', evidenceContract: 'Tests pass.' }],
      dependsOn: [],
      scope: { allowedPaths: ['src/api.ts'], forbiddenPaths: [] },
      requiredInputs: [{ kind: 'file', ref: 'src/api.ts' }],
      risk: 'high'
    },
    {
      id: 'TEST-01',
      goal: 'Add tests for the API contract',
      acceptanceCriteria: [{ criterionId: 'AC-2', text: 'Coverage is present.' }],
      gates: [{ gateId: 'G-2', command: 'npm test', evidenceContract: 'Tests pass.' }],
      dependsOn: ['API-01'],
      scope: { allowedPaths: ['tests/api.test.ts'], forbiddenPaths: [] },
      requiredInputs: []
    }
  ]
};

test('routing proposal assigns logical profiles without concrete model identifiers', () => {
  const routed = applyRoutingProposal(plan);
  assert.equal(routed.tasks[0]?.executionProfile, 'balanced-default-v1');
  assert.equal(routed.tasks[1]?.executionProfile, 'mechanical-fast-v1');
  assert.match(JSON.stringify(routed), /planner-logical-v1/);
  assert.doesNotMatch(JSON.stringify(routed), /claude-sonnet|gpt-/i);
});

test('worker projection produces schema-compatible task primitives', () => {
  const routed = applyRoutingProposal(plan);
  const projection = projectToWorkerV1(routed);
  assert.equal(projection.manifestTasks[0]?.kind, 'contract');
  assert.equal(projection.manifestTasks[1]?.kind, 'test');
  assert.deepEqual(validateWorkerTaskExport(projection.manifestTasks), []);
});

test('replan assigns a replacement profile only to incomplete tasks', () => {
  const result = replanFromWorkerFeedback(plan, {
    payload: { status: 'BLOCKED', executedTasks: ['API-01'], findings: [] }
  }, { profile: 'balanced-default-v1' });
  assert.deepEqual(result.affectedTaskIds, ['TEST-01']);
  assert.equal(result.plan.tasks[0]?.executionProfile, undefined);
  assert.equal(result.plan.tasks[1]?.executionProfile, 'balanced-default-v1');
});

test('context formatting keeps optional provider state explicit', () => {
  const text = contextForPrompt({
    status: 'UNAVAILABLE',
    provider: 'ai-code-control',
    warnings: ['executable not found']
  });
  assert.match(text, /UNAVAILABLE/);
  assert.match(text, /executable not found/);
});
