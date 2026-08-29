import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { lintPlan } from '../../src/linter/lint-plan.js';
import type { Plan, PlanTask } from '../../src/types.js';

function loadFixture(relativePath: string): unknown {
  return JSON.parse(readFileSync(resolve(process.cwd(), relativePath), 'utf-8'));
}

// Worker v1.0 task shape (flat strings for acceptanceCriteria/verify/requiredInputs)
interface WorkerV1Task {
  id: string;
  role?: string;
  dependsOn: string[];
  requiredInputs: string[];
  allowedPaths: string[];
  forbiddenPaths: string[];
  acceptanceCriteria: string[];
  verify: string[];
  risk?: string;
}

interface WorkerV1Manifest {
  goal: string;
  tasks: WorkerV1Task[];
}

function adaptWorkerV1ToPlan(manifest: WorkerV1Manifest): Plan {
  return {
    goal: manifest.goal,
    tasks: manifest.tasks.map((t): PlanTask => ({
      id: t.id,
      goal: t.role ?? t.id,
      acceptanceCriteria: t.acceptanceCriteria.map((text, i) => ({
        criterionId: `${t.id}-AC-${i + 1}`,
        text,
      })),
      gates: t.verify.map((command, i) => ({
        gateId: `${t.id}-G-${i + 1}`,
        command,
        evidenceContract: 'Exit code 0.',
        criterionIds: t.acceptanceCriteria.map((_, criterionIndex) => `${t.id}-AC-${criterionIndex + 1}`),
      })),
      dependsOn: t.dependsOn,
      scope: { allowedPaths: t.allowedPaths, forbiddenPaths: t.forbiddenPaths },
      requiredInputs: t.requiredInputs.map(ref => ({ kind: 'file', ref })),
      risk: (t.risk as 'low' | 'medium' | 'high') ?? 'low',
    })),
  };
}

test('valid fixture returns ok: true', () => {
  const raw = loadFixture('fixtures/valid/worker-v1.manifest.json') as WorkerV1Manifest;
  const plan = adaptWorkerV1ToPlan(raw);
  const result = lintPlan(plan);
  assert.strictEqual(
    result.ok,
    true,
    `Expected ok: true but got findings: ${JSON.stringify(result.findings, null, 2)}`,
  );
  assert.deepStrictEqual(result.findings, []);
});

test('cyclic-dependency fixture trips CYCLIC_DEPENDENCY', () => {
  const plan = loadFixture('fixtures/invalid/cyclic-dependency.json') as unknown as Plan;
  const result = lintPlan(plan);
  assert.strictEqual(result.ok, false);
  assert.ok(
    result.findings.some(f => f.claim.includes('CYCLIC_DEPENDENCY')),
    `Expected a CYCLIC_DEPENDENCY finding but got: ${JSON.stringify(result.findings)}`,
  );
});

test('unknown-depends-on fixture trips UNKNOWN_DEPENDENCY', () => {
  const plan = loadFixture('fixtures/invalid/unknown-depends-on.json') as unknown as Plan;
  const result = lintPlan(plan);
  assert.strictEqual(result.ok, false);
  assert.ok(
    result.findings.some(f => f.claim.includes('UNKNOWN_DEPENDENCY')),
    `Expected an UNKNOWN_DEPENDENCY finding but got: ${JSON.stringify(result.findings)}`,
  );
});

test('untyped-input fixture trips UNTYPED_INPUT', () => {
  const plan = loadFixture('fixtures/invalid/untyped-input.json') as unknown as Plan;
  const result = lintPlan(plan);
  assert.strictEqual(result.ok, false);
  assert.ok(
    result.findings.some(f => f.claim.includes('UNTYPED_INPUT')),
    `Expected an UNTYPED_INPUT finding but got: ${JSON.stringify(result.findings)}`,
  );
});

test('scope-overlap fixture trips SCOPE_OVERLAP', () => {
  const plan = loadFixture('fixtures/invalid/scope-overlap.json') as unknown as Plan;
  const result = lintPlan(plan);
  assert.strictEqual(result.ok, false);
  assert.ok(
    result.findings.some(f => f.claim.includes('SCOPE_OVERLAP')),
    `Expected a SCOPE_OVERLAP finding but got: ${JSON.stringify(result.findings)}`,
  );
});

test('paths-intersect fixture trips SCOPE_SELF_INTERSECTION', () => {
  const plan = loadFixture('fixtures/invalid/paths-intersect.json') as unknown as Plan;
  const result = lintPlan(plan);
  assert.strictEqual(result.ok, false);
  assert.ok(
    result.findings.some(f => f.claim.includes('SCOPE_SELF_INTERSECTION')),
    `Expected a SCOPE_SELF_INTERSECTION finding but got: ${JSON.stringify(result.findings)}`,
  );
});

test('high-risk-empty-verify fixture trips HIGH_RISK_NO_GATES', () => {
  const plan = loadFixture('fixtures/invalid/high-risk-empty-verify.json') as unknown as Plan;
  const result = lintPlan(plan);
  assert.strictEqual(result.ok, false);
  assert.ok(
    result.findings.some(f => f.claim.includes('HIGH_RISK_NO_GATES')),
    `Expected a HIGH_RISK_NO_GATES finding but got: ${JSON.stringify(result.findings)}`,
  );
});

test('dangling-criterion-id fixture trips UNKNOWN_CRITERION', () => {
  const plan = loadFixture('fixtures/invalid/dangling-criterion-id.json') as unknown as Plan;
  const result = lintPlan(plan);
  assert.strictEqual(result.ok, false);
  assert.ok(
    result.findings.some(f => f.claim.includes('UNKNOWN_CRITERION')),
    `Expected an UNKNOWN_CRITERION finding but got: ${JSON.stringify(result.findings)}`,
  );
});

test('plan with no violations returns ok: true and empty findings', () => {
  const plan: Plan = {
    goal: 'A clean plan',
    tasks: [
      {
        id: 'TASK-A',
        goal: 'Do something safe',
        acceptanceCriteria: [{ criterionId: 'AC-1', text: 'Output exists.' }],
        gates: [{ gateId: 'G-1', command: 'verify-a', evidenceContract: 'Exit code 0.', criterionIds: ['AC-1'] }],
        dependsOn: [],
        scope: { allowedPaths: ['src/a/**'], forbiddenPaths: ['src/b/**'] },
        requiredInputs: [{ kind: 'file', ref: 'docs/spec.md' }],
        risk: 'low',
      },
    ],
  };
  const result = lintPlan(plan);
  assert.strictEqual(result.ok, true);
  assert.deepStrictEqual(result.findings, []);
});
