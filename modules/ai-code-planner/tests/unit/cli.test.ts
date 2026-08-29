import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import type { Plan } from '../../src/types.js';

function runCli(args: string[]): { stdout: string; exitCode: number } {
  try {
    const stdout = execFileSync(
      process.execPath,
      [resolve('dist/src/cli.js'), ...args],
      { encoding: 'utf8' }
    );
    return { stdout, exitCode: 0 };
  } catch (err) {
    const e = err as { stdout?: string; status?: number };
    return { stdout: e.stdout ?? '', exitCode: e.status ?? 1 };
  }
}

// Creates a directly-executable fake claude that responds to -p with the given responseText
function createFakeClaudeExec(dir: string, responseText: string): string {
  const scriptPath = join(dir, 'fake-claude-script.mjs');

  const envelope = JSON.stringify({
    type: 'result',
    subtype: 'success',
    is_error: false,
    result: responseText,
    usage: { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    modelUsage: { 'claude-sonnet-5': { inputTokens: 10, outputTokens: 20 } }
  });

  const scriptSource = `import { readFileSync } from 'node:fs';
const args = process.argv.slice(2);
if (args[0] === '-p') {
  try { readFileSync(0, 'utf8'); } catch {}
  console.log(${JSON.stringify(envelope)});
  process.exit(0);
}
process.exit(2);
`;
  writeFileSync(scriptPath, scriptSource, 'utf8');

  if (process.platform === 'win32') {
    const wrapperPath = join(dir, 'fake-claude.cmd');
    writeFileSync(wrapperPath, `@echo off\r\n"${process.execPath}" "${scriptPath}" %*\r\n`, 'utf8');
    return wrapperPath;
  }

  const wrapperPath = join(dir, 'fake-claude');
  writeFileSync(wrapperPath, `#!/bin/sh\nexec "${process.execPath}" "${scriptPath}" "$@"\n`, 'utf8');
  chmodSync(wrapperPath, 0o755);
  return wrapperPath;
}

const VALID_PLAN: Plan = {
  goal: 'CLI test goal',
  tasks: [
    {
      id: 'T-01',
      goal: 'Do something useful',
      acceptanceCriteria: [{ criterionId: 'AC-001', text: 'Something is done correctly' }],
      gates: [{ gateId: 'G-001', command: 'npm test', evidenceContract: 'Tests pass with exit 0', criterionIds: ['AC-001'] }],
      dependsOn: [],
      scope: { allowedPaths: ['src/test.ts'], forbiddenPaths: [] },
      requiredInputs: [{ kind: 'file', ref: 'src/test.ts' }]
    }
  ]
};

test('propose with fake --claude-executable produces a draft that inspect reports as schemaValid and lintOk', () => {
  const tmpDir = mkdtempSync(join(tmpdir(), 'cli-test-propose-'));
  try {
    const fakeClaudeExec = createFakeClaudeExec(tmpDir, JSON.stringify(VALID_PLAN));
    const draftPath = join(tmpDir, 'draft.plan.json');

    const proposeResult = runCli([
      'propose', 'test implementation task',
      '--out', draftPath,
      '--claude-executable', fakeClaudeExec
    ]);
    assert.strictEqual(
      proposeResult.exitCode,
      0,
      `propose failed (exit ${proposeResult.exitCode}): ${proposeResult.stdout}`
    );

    const inspectResult = runCli(['inspect', draftPath, '--json']);
    assert.ok(inspectResult.stdout.trim().length > 0, 'inspect produced no output');

    const report = JSON.parse(inspectResult.stdout) as {
      schemaValid: boolean;
      schemaErrors: string[];
      lintOk: boolean;
      findings: unknown[];
    };
    assert.strictEqual(report.schemaValid, true, `Schema invalid: ${JSON.stringify(report.schemaErrors)}`);
    assert.strictEqual(report.lintOk, true, `Lint failed: ${JSON.stringify(report.findings)}`);
    assert.strictEqual(inspectResult.exitCode, 0);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('compile on a valid draft produces a Plan markdown file with required task fields', () => {
  const tmpDir = mkdtempSync(join(tmpdir(), 'cli-test-compile-'));
  try {
    const draftPath = join(tmpDir, 'draft.plan.json');
    writeFileSync(draftPath, JSON.stringify(VALID_PLAN), 'utf-8');

    const planPath = join(tmpDir, 'Plan', 'T-01.md');

    const compileResult = runCli([
      'compile', draftPath,
      '--task-id', 'T-01',
      '--out', planPath
    ]);
    assert.strictEqual(
      compileResult.exitCode,
      0,
      `compile failed (exit ${compileResult.exitCode}): ${compileResult.stdout}`
    );

    const content = readFileSync(planPath, 'utf-8');
    const match = content.match(/```ai-code-worker-plan\n([\s\S]*?)\n```/);
    assert.ok(match, 'No ai-code-worker-plan block found in compiled plan');

    const planData = JSON.parse(match[1] as string) as { workerContractVersion: string; goal: string; tasks: Record<string, unknown>[] };
    assert.strictEqual(planData.workerContractVersion, '1.1');
    assert.ok(Array.isArray(planData.tasks), 'tasks should be an array');
    assert.ok(planData.tasks.length > 0, 'tasks array should not be empty');

    const requiredFields = [
      'id', 'kind', 'role', 'dependsOn', 'requiredInputs',
      'allowedPaths', 'forbiddenPaths', 'expectedArtifacts',
      'acceptanceCriteria', 'verify', 'concurrencyKeys', 'risk', 'traceability'
    ];
    for (const task of planData.tasks) {
      for (const field of requiredFields) {
        assert.ok(field in task, `Task missing required field: ${field} in task ${JSON.stringify(task)}`);
      }
    }
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('inspect on a draft with a DAG cycle reports lintOk:false with a CYCLIC_DEPENDENCY finding', () => {
  const tmpDir = mkdtempSync(join(tmpdir(), 'cli-test-cycle-'));
  try {
    const cyclicPlan: Plan = {
      goal: 'Cyclic plan',
      tasks: [
        {
          id: 'A',
          goal: 'Task A',
          acceptanceCriteria: [{ criterionId: 'AC-A', text: 'A done' }],
          gates: [],
          dependsOn: ['B'],
          scope: { allowedPaths: ['src/a.ts'], forbiddenPaths: [] },
          requiredInputs: [{ kind: 'file', ref: 'src/a.ts' }]
        },
        {
          id: 'B',
          goal: 'Task B',
          acceptanceCriteria: [{ criterionId: 'AC-B', text: 'B done' }],
          gates: [],
          dependsOn: ['A'],
          scope: { allowedPaths: ['src/b.ts'], forbiddenPaths: [] },
          requiredInputs: [{ kind: 'file', ref: 'src/b.ts' }]
        }
      ]
    };

    const draftPath = join(tmpDir, 'cyclic.plan.json');
    writeFileSync(draftPath, JSON.stringify(cyclicPlan), 'utf-8');

    const inspectResult = runCli(['inspect', draftPath, '--json']);
    assert.strictEqual(inspectResult.exitCode, 2, 'Expected exit code 2 for cyclic plan');

    const report = JSON.parse(inspectResult.stdout) as {
      schemaValid: boolean;
      lintOk: boolean;
      findings: Array<{ claim: string }>;
    };
    assert.strictEqual(report.schemaValid, true, 'Schema should be valid');
    assert.strictEqual(report.lintOk, false, 'Lint should fail for cyclic plan');
    assert.ok(
      report.findings.some(f => f.claim.includes('CYCLIC_DEPENDENCY')),
      `Expected CYCLIC_DEPENDENCY finding, got: ${JSON.stringify(report.findings)}`
    );
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('explain-routing prints only unresolved note and never a resolved engine or model', () => {
  const tmpDir = mkdtempSync(join(tmpdir(), 'cli-test-routing-'));
  try {
    const planWithProfile: Plan = {
      goal: 'Routing test goal',
      tasks: [
        {
          id: 'T-01',
          goal: 'Task with execution profile',
          acceptanceCriteria: [{ criterionId: 'AC-001', text: 'Done' }],
          gates: [],
          dependsOn: [],
          scope: { allowedPaths: ['src/t.ts'], forbiddenPaths: [] },
          requiredInputs: [{ kind: 'file', ref: 'src/t.ts' }],
          executionProfile: 'backend-balanced-v1'
        },
        {
          id: 'T-02',
          goal: 'Task without execution profile',
          acceptanceCriteria: [{ criterionId: 'AC-002', text: 'Done' }],
          gates: [],
          dependsOn: ['T-01'],
          scope: { allowedPaths: ['src/u.ts'], forbiddenPaths: [] },
          requiredInputs: [{ kind: 'file', ref: 'src/u.ts' }]
        }
      ]
    };

    const draftPath = join(tmpDir, 'routing-draft.plan.json');
    writeFileSync(draftPath, JSON.stringify(planWithProfile), 'utf-8');

    const result = runCli(['explain-routing', draftPath]);
    assert.strictEqual(result.exitCode, 0);

    // T-01 should show the profile name with the unresolved note
    assert.ok(result.stdout.includes('T-01'), 'Should mention T-01');
    assert.ok(result.stdout.includes('backend-balanced-v1'), 'Should mention the profile name');
    assert.ok(
      result.stdout.includes('declared, not resolved'),
      'Should include the unresolved note'
    );

    // T-02 should indicate no profile was declared
    assert.ok(result.stdout.includes('T-02'), 'Should mention T-02');
    assert.ok(
      result.stdout.includes('no executionProfile declared'),
      'Should note no profile for T-02'
    );

    // MUST NOT include any resolved routing decision (engine, model, or confidence)
    const outputLines = result.stdout.split('\n').filter(l => l.trim().length > 0);
    for (const line of outputLines) {
      assert.ok(
        !line.includes('engine:') && !line.includes('model:') && !line.includes('confidence:'),
        `Line must not contain resolved routing info: ${line}`
      );
    }
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});
