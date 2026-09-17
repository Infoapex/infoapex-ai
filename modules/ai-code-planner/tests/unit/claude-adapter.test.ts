import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createClaudeAdapter } from '../../src/engine/claude-adapter.js';
import { writeFakeClaudeCli } from '../helpers/fake-claude-cli.js';

function makeTempDir(): string {
  // Node 24 reports macOS temporary directories through their canonical
  // /private/var path, while tmpdir() may still expose the /var alias.
  return realpathSync.native(mkdtempSync(join(tmpdir(), 'claude-adapter-test-')));
}

test('ask() returns ok:true with text matching configured responseText', () => {
  const dir = makeTempDir();
  const scriptPath = join(dir, 'fake-claude.mjs');
  writeFakeClaudeCli(scriptPath, { responseText: 'Hello from fake Claude' });

  const adapter = createClaudeAdapter({
    executable: process.execPath,
    baseArgs: [scriptPath]
  });

  const result = adapter.ask('a prompt');
  assert.strictEqual(result.ok, true);
  if (result.ok) {
    assert.strictEqual(result.text, 'Hello from fake Claude');
  }
});

test('ask() returns ok:false with non-empty error when fake CLI exits non-zero', () => {
  const dir = makeTempDir();
  const scriptPath = join(dir, 'fake-claude-fail.mjs');
  writeFileSync(scriptPath, 'process.exit(1);\n', 'utf8');

  const adapter = createClaudeAdapter({
    executable: process.execPath,
    baseArgs: [scriptPath]
  });

  const result = adapter.ask('a prompt');
  assert.strictEqual(result.ok, false);
  if (!result.ok) {
    assert.ok(result.error.length > 0, 'Expected a non-empty error string');
  }
});

test('ask() runs the Claude CLI in the configured repository cwd', () => {
  const dir = makeTempDir();
  const scriptPath = join(dir, 'fake-claude-cwd.mjs');
  const cwdPath = join(dir, 'observed-cwd.txt');
  const source = `import { writeFileSync } from 'node:fs';
writeFileSync(${JSON.stringify(cwdPath)}, process.cwd(), 'utf8');
console.log(${JSON.stringify(JSON.stringify({ result: 'ok', usage: {}, modelUsage: { 'test-model': {} } }))});
`;
  writeFileSync(scriptPath, source, 'utf8');

  const adapter = createClaudeAdapter({
    executable: process.execPath,
    baseArgs: [scriptPath],
    cwd: dir,
    timeoutMs: 5_000
  });

  const result = adapter.ask('a prompt');
  assert.equal(result.ok, true);
  assert.equal(readFileSync(cwdPath, 'utf8'), dir);
});
