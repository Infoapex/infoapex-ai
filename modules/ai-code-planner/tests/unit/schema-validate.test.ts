import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateAgainstSchema } from '../../src/schema-validate.js';
import type { Plan, Finding } from '../../src/types.js';

const minimalValidPlan: Pick<Plan, 'goal' | 'tasks'> = {
  goal: 'Test goal',
  tasks: [],
};

const minimalValidFinding: Finding = {
  id: 'FIND-001',
  type: 'unverified-claim',
  severity: 'minor',
  claim: 'This is a test finding',
  status: 'proposed',
};

test('validates a minimal valid plan against plan.schema.json', () => {
  const result = validateAgainstSchema<Plan>('plan.schema.json', minimalValidPlan);
  assert.strictEqual(result.valid, true);
});

test('rejects a plan missing the required goal field', () => {
  const result = validateAgainstSchema<Plan>('plan.schema.json', { tasks: [] });
  assert.strictEqual(result.valid, false);
  if (!result.valid) {
    assert.ok(result.errors.length > 0, 'Expected at least one error string');
  }
});

test('validates a minimal valid finding against finding.schema.json', () => {
  const result = validateAgainstSchema<Finding>('finding.schema.json', minimalValidFinding);
  assert.strictEqual(result.valid, true);
});

test('rejects a finding with an invalid severity enum value', () => {
  const invalidFinding = { ...minimalValidFinding, severity: 'critical' };
  const result = validateAgainstSchema<Finding>('finding.schema.json', invalidFinding);
  assert.strictEqual(result.valid, false);
  if (!result.valid) {
    assert.ok(result.errors.length > 0, 'Expected at least one error string');
  }
});
