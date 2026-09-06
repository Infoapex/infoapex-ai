import { spawnSync } from 'node:child_process';
import { createClaudeAdapter, type ClaudeAdapterConfig } from './claude-adapter.js';
import { createCodexAdapter, type CodexAdapterConfig } from './codex-adapter.js';
import type { PlannerAdapter, PlannerProviderId, ReasoningEffort } from './planner-adapter.js';

export interface ProviderSelection {
  readonly providerId: PlannerProviderId;
  readonly model: string;
  readonly reasoningEffort: ReasoningEffort;
  readonly selectionReason: string;
  readonly estimatedCostUsd: number;
  readonly fallback: {
    readonly approved: boolean;
    readonly providerId?: PlannerProviderId;
    readonly model?: string;
    readonly reasoningEffort?: ReasoningEffort;
    readonly reason?: string;
  };
}

export interface ProviderPreflight {
  readonly status: 'PASS' | 'BLOCKED';
  readonly providerId: PlannerProviderId;
  readonly executable: string;
  readonly executableVersion: string | null;
  readonly requestedModel: string;
  readonly reasoningEffort: ReasoningEffort;
  readonly selectionReason: string;
  readonly estimatedCostUsd: number;
  readonly fallback: ProviderSelection['fallback'];
  readonly findings: readonly string[];
}

export interface AdapterOptions {
  readonly executable?: string;
  readonly baseArgs?: readonly string[];
  readonly cwd?: string;
  readonly timeoutMs?: number;
  readonly maximumOutputBytes?: number;
}

const EFFORTS: readonly ReasoningEffort[] = ['low', 'medium', 'high', 'xhigh', 'max'];

export function registeredProviders(): readonly { id: PlannerProviderId; executable: string; supportsExplicitEffort: true; automaticFallback: false }[] {
  return [
    { id: 'codex', executable: 'codex', supportsExplicitEffort: true, automaticFallback: false },
    { id: 'claude', executable: 'claude', supportsExplicitEffort: true, automaticFallback: false }
  ];
}

export function validateProviderSelection(value: {
  provider?: string | null;
  model?: string | null;
  reasoningEffort?: string | null;
  selectionReason?: string | null;
  estimatedCostUsd?: number | null;
  fallbackProvider?: string | null;
  fallbackModel?: string | null;
  fallbackReasoningEffort?: string | null;
  fallbackReason?: string | null;
}): { ok: true; selection: ProviderSelection } | { ok: false; errors: readonly string[] } {
  const errors: string[] = [];
  const provider = value.provider;
  if (provider !== 'codex' && provider !== 'claude') errors.push('Missing or unsupported --provider. Use codex or claude.');
  if (!value.model?.trim()) errors.push('Missing required --model. No provider default is permitted.');
  if (!value.reasoningEffort || !EFFORTS.includes(value.reasoningEffort as ReasoningEffort)) errors.push(`Missing or invalid --reasoning-effort. Use ${EFFORTS.join(', ')}.`);
  if (!value.selectionReason?.trim()) errors.push('Missing required --selection-reason.');
  if (value.estimatedCostUsd === null || value.estimatedCostUsd === undefined || !Number.isFinite(value.estimatedCostUsd) || value.estimatedCostUsd < 0) errors.push('Missing or invalid --estimated-cost-usd.');

  const fallbackValues = [value.fallbackProvider, value.fallbackModel, value.fallbackReasoningEffort, value.fallbackReason].filter(item => item !== null && item !== undefined);
  if (fallbackValues.length > 0) {
    if (value.fallbackProvider !== 'codex' && value.fallbackProvider !== 'claude') errors.push('Fallback requires --fallback-provider codex|claude.');
    if (!value.fallbackModel?.trim()) errors.push('Fallback requires --fallback-model.');
    if (!value.fallbackReasoningEffort || !EFFORTS.includes(value.fallbackReasoningEffort as ReasoningEffort)) errors.push('Fallback requires a valid --fallback-reasoning-effort.');
    if (!value.fallbackReason?.trim()) errors.push('Fallback requires --fallback-reason.');
  }

  if (errors.length > 0 || (provider !== 'codex' && provider !== 'claude') || !value.model || !value.reasoningEffort || !value.selectionReason || value.estimatedCostUsd === null || value.estimatedCostUsd === undefined) {
    return { ok: false, errors };
  }

  const fallback = fallbackValues.length === 0
    ? { approved: false as const }
    : {
      approved: true as const,
      providerId: value.fallbackProvider as PlannerProviderId,
      model: value.fallbackModel!,
      reasoningEffort: value.fallbackReasoningEffort as ReasoningEffort,
      reason: value.fallbackReason!
    };
  return {
    ok: true,
    selection: {
      providerId: provider,
      model: value.model,
      reasoningEffort: value.reasoningEffort as ReasoningEffort,
      selectionReason: value.selectionReason,
      estimatedCostUsd: value.estimatedCostUsd,
      fallback
    }
  };
}

export function preflightProvider(selection: ProviderSelection, options: AdapterOptions = {}): ProviderPreflight {
  const executable = options.executable ?? selection.providerId;
  const child = spawnSync(executable, [...(options.baseArgs ?? []), '--version'], {
    ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
    encoding: 'utf8',
    timeout: options.timeoutMs ?? 10_000,
    maxBuffer: options.maximumOutputBytes ?? 64 * 1024,
    windowsHide: true,
    shell: process.platform === 'win32' && /\.(cmd|bat)$/i.test(executable)
  });
  const findings: string[] = [];
  let version: string | null = null;
  if (child.error) findings.push(`Provider executable unavailable: ${child.error.message}`);
  else if (child.status !== 0) findings.push(`Provider executable returned exit code ${child.status ?? 'unknown'} during --version.`);
  else version = typeof child.stdout === 'string' ? child.stdout.trim().slice(0, 500) || null : null;

  return {
    status: findings.length === 0 ? 'PASS' : 'BLOCKED',
    providerId: selection.providerId,
    executable,
    executableVersion: version,
    requestedModel: selection.model,
    reasoningEffort: selection.reasoningEffort,
    selectionReason: selection.selectionReason,
    estimatedCostUsd: selection.estimatedCostUsd,
    fallback: selection.fallback,
    findings
  };
}

export function createProviderAdapter(selection: ProviderSelection, options: AdapterOptions = {}): PlannerAdapter {
  if (selection.providerId === 'claude') {
    const config: ClaudeAdapterConfig = {
      ...(options.executable !== undefined ? { executable: options.executable } : {}),
      ...(options.baseArgs !== undefined ? { baseArgs: options.baseArgs } : {}),
      ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
      defaultModel: selection.model,
      reasoningEffort: selection.reasoningEffort,
      ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
      ...(options.maximumOutputBytes !== undefined ? { maximumOutputBytes: options.maximumOutputBytes } : {})
    };
    return createClaudeAdapter(config);
  }
  const config: CodexAdapterConfig = {
    ...(options.executable !== undefined ? { executable: options.executable } : {}),
    ...(options.baseArgs !== undefined ? { baseArgs: options.baseArgs } : {}),
    ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
    model: selection.model,
    reasoningEffort: selection.reasoningEffort,
    ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
    ...(options.maximumOutputBytes !== undefined ? { maximumOutputBytes: options.maximumOutputBytes } : {})
  };
  return createCodexAdapter(config);
}
