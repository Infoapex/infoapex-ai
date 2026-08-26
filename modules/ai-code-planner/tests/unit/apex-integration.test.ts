import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { publishPlannerHandoff, readWorkerFeedback } from '../../src/integration/apex-integration.js';

test('planner publishes and consumes schema-valid immutable handoffs in an integrated repository', () => {
  const repository = makeRepository();
  try {
    const output = publishPlannerHandoff({
      repositoryPath: repository,
      planPath: 'Plan/task.md',
      runId: 'planner-run-1',
      goal: 'Implement safely',
      tasks: [{ id: 'TASK-1', executionProfile: 'balanced-default-v1' }],
    });
    assert.ok(output && existsSync(output));
    const plannerDocument = JSON.parse(readFileSync(output, 'utf8'));
    assert.equal(plannerDocument.direction, 'planner-to-worker');
    assert.equal(plannerDocument.runId, 'planner-run-1');

    assert.throws(
      () => publishPlannerHandoff({
        repositoryPath: repository,
        planPath: 'Plan/changed.md',
        runId: 'planner-run-1',
        goal: 'Must not replace the first handoff',
        tasks: [],
      }),
      /EEXIST|already exists/i,
    );
    assert.equal(JSON.parse(readFileSync(output, 'utf8')).payload.planPath, 'Plan/task.md');

    writeJson(join(repository, '.infoapex-ai', 'runs', 'planner-run-1', 'worker-to-planner.json'), {
      schemaVersion: '1.0',
      handoffId: 'worker-feedback-1',
      direction: 'worker-to-planner',
      createdAt: new Date().toISOString(),
      runId: 'planner-run-1',
      payload: { status: 'DONE', findings: [] },
    });
    const feedback = readWorkerFeedback(repository, 'planner-run-1') as { payload: { status: string } };
    assert.equal(feedback.payload.status, 'DONE');
  } finally {
    rmSync(repository, { recursive: true, force: true });
  }
});

test('planner rejects unsafe run IDs before reading integration state', () => {
  const repository = mkdtempSync(join(tmpdir(), 'aicp-apex-run-id-'));
  try {
    for (const runId of ['..', '../escaped', '..\\escaped', '/tmp/escaped', 'C:\\escaped', 'C:escaped', '\\\\server\\share', 'foo.', 'NUL']) {
      assert.throws(
        () => publishPlannerHandoff({ repositoryPath: repository, planPath: 'Plan/task.md', runId, goal: 'x', tasks: [] }),
        /Invalid runId/,
        runId,
      );
      assert.throws(() => readWorkerFeedback(repository, runId), /Invalid runId/, runId);
    }
    assert.equal(existsSync(join(repository, '.infoapex-ai')), false);
  } finally {
    rmSync(repository, { recursive: true, force: true });
  }
});

test('planner rejects invalid config paths and malformed or mismatched feedback envelopes', () => {
  const repository = makeRepository();
  try {
    const configPath = join(repository, '.infoapex-ai', 'config.json');
    writeJson(configPath, { schemaVersion: '1.0', mode: 'integrated', handoffRoot: '../escaped' });
    assert.throws(
      () => publishPlannerHandoff({ repositoryPath: repository, planPath: 'Plan/task.md', runId: 'safe-run', goal: 'x', tasks: [] }),
      /Invalid handoffRoot/,
    );

    writeConfig(repository);
    const feedbackPath = join(repository, '.infoapex-ai', 'runs', 'safe-run', 'worker-to-planner.json');
    writeJson(feedbackPath, {
      schemaVersion: '1.0',
      handoffId: 'invalid-payload',
      direction: 'worker-to-planner',
      createdAt: new Date().toISOString(),
      runId: 'safe-run',
      payload: [],
    });
    assert.throws(() => readWorkerFeedback(repository, 'safe-run'), /Invalid infoapex-ai handoff/);

    writeJson(feedbackPath, {
      schemaVersion: '1.0',
      handoffId: 'wrong-run',
      direction: 'worker-to-planner',
      createdAt: new Date().toISOString(),
      runId: 'another-run',
      payload: { status: 'DONE' },
    });
    assert.throws(() => readWorkerFeedback(repository, 'safe-run'), /runId mismatch/);
  } finally {
    rmSync(repository, { recursive: true, force: true });
  }
});

test('planner rejects an integration config symlink or junction that escapes the repository', (context) => {
  const repository = mkdtempSync(join(tmpdir(), 'aicp-apex-config-link-'));
  const external = mkdtempSync(join(tmpdir(), 'aicp-apex-config-target-'));
  try {
    writeJson(join(external, 'config.json'), {
      schemaVersion: '1.0',
      mode: 'integrated',
      handoffRoot: '.infoapex-ai/runs',
      planner: { enabled: true },
    });
    try {
      symlinkSync(external, join(repository, '.infoapex-ai'), process.platform === 'win32' ? 'junction' : 'dir');
    } catch (error) {
      context.skip(`Symlink/junction creation is unavailable: ${String(error)}`);
      return;
    }

    assert.throws(
      () => publishPlannerHandoff({
        repositoryPath: repository,
        planPath: 'Plan/task.md',
        runId: 'linked-config-run',
        goal: 'x',
        tasks: [],
      }),
      /escapes|outside/,
    );
  } finally {
    rmSync(repository, { recursive: true, force: true });
    rmSync(external, { recursive: true, force: true });
  }
});

test('planner rejects a run directory junction that escapes handoffRoot', (context) => {
  const repository = makeRepository();
  const external = mkdtempSync(join(tmpdir(), 'aicp-apex-run-target-'));
  try {
    mkdirSync(join(repository, '.infoapex-ai', 'runs'), { recursive: true });
    try {
      symlinkSync(
        external,
        join(repository, '.infoapex-ai', 'runs', 'linked-run'),
        process.platform === 'win32' ? 'junction' : 'dir',
      );
    } catch (error) {
      context.skip(`Symlink/junction creation is unavailable: ${String(error)}`);
      return;
    }

    assert.throws(
      () => publishPlannerHandoff({
        repositoryPath: repository,
        planPath: 'Plan/task.md',
        runId: 'linked-run',
        goal: 'x',
        tasks: [],
      }),
      /escapes handoffRoot|resolves outside/,
    );
    assert.throws(
      () => readWorkerFeedback(repository, 'linked-run'),
      /escapes handoffRoot|resolves outside/,
    );
  } finally {
    rmSync(repository, { recursive: true, force: true });
    rmSync(external, { recursive: true, force: true });
  }
});

function makeRepository(): string {
  const repository = mkdtempSync(join(tmpdir(), 'aicp-apex-'));
  writeConfig(repository);
  return repository;
}

function writeConfig(repository: string): void {
  writeJson(join(repository, '.infoapex-ai', 'config.json'), {
    schemaVersion: '1.0',
    mode: 'integrated',
    handoffRoot: '.infoapex-ai/runs',
    planner: { enabled: true },
    worker: { enabled: true },
  });
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}
