import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createClaudeAdapter } from '../../src/engine/claude-adapter.js';
import { writeFakeClaudeCli } from '../helpers/fake-claude-cli.js';
import { decomposePrompt } from '../../src/decompose/decompose-prompt.js';
import type { Plan } from '../../src/types.js';

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), 'decompose-prompt-test-'));
}

const MINIMAL_PLAN: Plan = {
  goal: 'Implement a hello world function',
  tasks: [
    {
      id: 'HELLO-01',
      goal: 'Write the hello world function',
      acceptanceCriteria: [
        { criterionId: 'c1', text: 'Function returns "hello world"' }
      ],
      gates: [
        { gateId: 'g1', command: 'npm test', evidenceContract: 'All tests pass with exit code 0' }
      ],
      dependsOn: [],
      scope: {
        allowedPaths: ['src/hello.ts'],
        forbiddenPaths: []
      },
      requiredInputs: [
        { kind: 'file', ref: 'src/hello.ts' }
      ]
    }
  ]
};

test('decomposePrompt returns ok:true when adapter returns prose wrapping a valid Plan JSON', () => {
  const dir = makeTempDir();
  const scriptPath = join(dir, 'fake-claude.mjs');

  // Prose wrapper proves extraction-from-prose path, not just bare JSON response
  const proseWrapped =
    `Here is the implementation plan I have decomposed for you:\n\n${JSON.stringify(MINIMAL_PLAN)}`;
  writeFakeClaudeCli(scriptPath, { responseText: proseWrapped });

  const adapter = createClaudeAdapter({
    executable: process.execPath,
    baseArgs: [scriptPath]
  });

  const result = decomposePrompt(adapter, 'Implement a hello world function');

  assert.strictEqual(result.ok, true);
  if (result.ok) {
    assert.strictEqual(result.plan.goal, MINIMAL_PLAN.goal);
    assert.strictEqual(result.plan.tasks.length, 1);
    assert.strictEqual(result.plan.tasks[0]?.id, 'HELLO-01');
    assert.strictEqual(result.plan.tasks[0]?.acceptanceCriteria[0]?.criterionId, 'c1');
  }
});

test('decomposePrompt returns ok:false after exactly 2 adapter calls when both return invalid JSON', () => {
  const dir = makeTempDir();
  const scriptPath = join(dir, 'fake-claude-invalid.mjs');
  const counterPath = join(dir, 'call-count.txt');

  // The result text is a JSON object that parses successfully but fails plan schema validation
  const invalidPlanText = '{"not": "a valid plan"}';
  const envelope = JSON.stringify({
    result: invalidPlanText,
    usage: {
      input_tokens: 1,
      output_tokens: 1,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0
    },
    modelUsage: { 'claude-sonnet-5': { inputTokens: 1, outputTokens: 1 } }
  });

  // Counter file incremented on each invocation so the test can assert exactly 2 calls
  const scriptSource = `import { readFileSync, writeFileSync } from 'node:fs';
const args = process.argv.slice(2);
if (args[0] === '-p') {
  readFileSync(0, 'utf8');
  let count = 0;
  try { count = parseInt(readFileSync(${JSON.stringify(counterPath)}, 'utf8'), 10) || 0; } catch {}
  writeFileSync(${JSON.stringify(counterPath)}, String(count + 1), 'utf8');
  console.log(${JSON.stringify(envelope)});
  process.exit(0);
}
process.exit(2);
`;
  writeFileSync(scriptPath, scriptSource, 'utf8');

  const adapter = createClaudeAdapter({
    executable: process.execPath,
    baseArgs: [scriptPath]
  });

  const result = decomposePrompt(adapter, 'Do something');

  // Must return ok:false after the retry, not before
  assert.strictEqual(result.ok, false);
  if (!result.ok) {
    // Error must include validation error details, not a generic message
    assert.ok(result.error.length > 0, 'Expected a non-empty error string');
    assert.ok(
      result.error.includes('validation') || result.error.includes('required') || result.error.includes('property'),
      `Expected error to include schema validation details, got: ${result.error}`
    );
  }

  // Assert exactly 2 adapter.ask() calls were made (initial + one retry)
  const callCount = parseInt(readFileSync(counterPath, 'utf8'), 10);
  assert.strictEqual(callCount, 2, 'Expected exactly 2 adapter.ask() calls (initial + one retry)');
});
