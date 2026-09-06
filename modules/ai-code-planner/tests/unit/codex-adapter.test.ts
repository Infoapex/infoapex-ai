import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createCodexAdapter } from '../../src/engine/codex-adapter.js';

test('Codex adapter passes an explicit model and effort and reads the schema-constrained final message', () => {
  const dir = mkdtempSync(join(tmpdir(), 'codex-adapter-test-'));
  const scriptPath = join(dir, 'fake-codex.mjs');
  const source = `import { writeFileSync } from 'node:fs';
const args = process.argv.slice(2);
if (args.includes('--version')) { console.log('fake codex 1.0'); process.exit(0); }
const outputIndex = args.indexOf('--output-last-message');
if (outputIndex < 0) process.exit(2);
writeFileSync(args[outputIndex + 1], JSON.stringify({ goal: 'test', tasks: [] }), 'utf8');
console.log(JSON.stringify({ type: 'thread.started', model: 'gpt-5.6-sol' }));
console.log(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 12, output_tokens: 34 } }));
`;
  writeFileSync(scriptPath, source, 'utf8');

  const adapter = createCodexAdapter({
    executable: process.execPath,
    baseArgs: [scriptPath],
    model: 'gpt-5.6-sol',
    reasoningEffort: 'xhigh'
  });
  const result = adapter.ask('Produce a plan');
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.providerId, 'codex');
    assert.equal(result.requestedModel, 'gpt-5.6-sol');
    assert.equal(result.resolvedModel, 'gpt-5.6-sol');
    assert.equal(result.reasoningEffort, 'xhigh');
    assert.equal(result.usage.inputTokens, 12);
    assert.equal(result.usage.outputTokens, 34);
    assert.equal(result.text, JSON.stringify({ goal: 'test', tasks: [] }));
  }
});
