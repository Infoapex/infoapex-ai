import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateProviderSelection } from '../../src/engine/provider-registry.js';

test('provider registry rejects implicit provider, model, effort, reason, and cost defaults', () => {
  const result = validateProviderSelection({});
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.ok(result.errors.some(error => error.includes('--provider')));
    assert.ok(result.errors.some(error => error.includes('--model')));
    assert.ok(result.errors.some(error => error.includes('--reasoning-effort')));
    assert.ok(result.errors.some(error => error.includes('--selection-reason')));
    assert.ok(result.errors.some(error => error.includes('--estimated-cost-usd')));
  }
});

test('provider registry records an explicit fallback but never enables an automatic one', () => {
  const result = validateProviderSelection({
    provider: 'codex',
    model: 'gpt-5.6-sol',
    reasoningEffort: 'xhigh',
    selectionReason: 'Architecture review',
    estimatedCostUsd: 1.5,
    fallbackProvider: 'claude',
    fallbackModel: 'opus',
    fallbackReasoningEffort: 'xhigh',
    fallbackReason: 'Approved only for a separately authorized retry.'
  });
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.selection.fallback.approved, true);
    assert.equal(result.selection.fallback.providerId, 'claude');
  }
});
