import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { PlannerAdapter, PlannerAskResult, PlannerUsage, ReasoningEffort } from './planner-adapter.js';

export interface CodexAdapterConfig {
  readonly executable?: string;
  readonly baseArgs?: readonly string[];
  readonly cwd?: string;
  readonly model: string;
  readonly reasoningEffort: ReasoningEffort;
  readonly timeoutMs?: number;
  readonly maximumOutputBytes?: number;
}

interface CodexEvent {
  readonly type?: unknown;
  readonly model?: unknown;
  readonly usage?: unknown;
  readonly response?: unknown;
}

function readInt(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : 0;
}

function readRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' ? value as Record<string, unknown> : {};
}

function parseEvents(stdout: string): { resolvedModel: string | null; usage: PlannerUsage } {
  let resolvedModel: string | null = null;
  let usage: PlannerUsage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 };

  for (const line of stdout.split(/\r?\n/)) {
    if (line.trim() === '') continue;
    let event: CodexEvent;
    try {
      event = JSON.parse(line) as CodexEvent;
    } catch {
      continue;
    }

    const response = readRecord(event.response);
    const model = typeof event.model === 'string' ? event.model : response.model;
    if (typeof model === 'string') resolvedModel = model;

    const candidateUsage = readRecord(event.usage);
    const responseUsage = readRecord(response.usage);
    const rawUsage = Object.keys(candidateUsage).length > 0 ? candidateUsage : responseUsage;
    if (Object.keys(rawUsage).length > 0) {
      const inputDetails = readRecord(rawUsage.input_tokens_details);
      const outputDetails = readRecord(rawUsage.output_tokens_details);
      usage = {
        inputTokens: readInt(rawUsage.input_tokens ?? rawUsage.inputTokens),
        outputTokens: readInt(rawUsage.output_tokens ?? rawUsage.outputTokens),
        cacheReadTokens: readInt(inputDetails.cached_tokens ?? rawUsage.cache_read_input_tokens ?? rawUsage.cacheReadTokens),
        cacheCreationTokens: readInt(inputDetails.cache_write_tokens ?? outputDetails.cache_write_tokens ?? rawUsage.cache_creation_input_tokens ?? rawUsage.cacheCreationTokens)
      };
    }
  }

  return { resolvedModel, usage };
}

export function createCodexAdapter(config: CodexAdapterConfig): PlannerAdapter {
  const executable = config.executable ?? 'codex';
  const baseArgs = config.baseArgs ?? [];
  const cwd = config.cwd;
  const timeoutMs = config.timeoutMs ?? 600_000;
  const maximumOutputBytes = config.maximumOutputBytes ?? 2 * 1024 * 1024;

  return {
    providerId: 'codex',
    ask(prompt: string): PlannerAskResult {
      const tempDir = mkdtempSync(join(tmpdir(), 'ai-code-planner-codex-'));
      const schemaPath = join(tempDir, 'plan-output.schema.json');
      const outputPath = join(tempDir, 'final-message.txt');
      writeFileSync(schemaPath, JSON.stringify(planOutputSchema()), 'utf8');

      try {
        const args = [
          ...baseArgs,
          'exec',
          '--ephemeral',
          '--ignore-user-config',
          '--sandbox', 'read-only',
          '--model', config.model,
          '--config', `model_reasoning_effort=${JSON.stringify(config.reasoningEffort)}`,
          '--output-schema', schemaPath,
          '--output-last-message', outputPath,
          '--json',
          prompt
        ];
        const child = spawnSync(executable, args, {
          ...(cwd !== undefined ? { cwd } : {}),
          encoding: 'utf8',
          timeout: timeoutMs,
          maxBuffer: maximumOutputBytes,
          windowsHide: true,
          shell: process.platform === 'win32' && /\.(cmd|bat)$/i.test(executable)
        });

        if (child.error) {
          const code = (child.error as NodeJS.ErrnoException).code;
          if (code === 'ETIMEDOUT') return { ok: false, error: `Codex adapter timed out after ${timeoutMs}ms.` };
          if (code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') return { ok: false, error: `Codex adapter output exceeded ${maximumOutputBytes} bytes.` };
          return { ok: false, error: `Codex adapter spawn error: ${child.error.message}` };
        }
        if (child.signal !== null || child.status === null) return { ok: false, error: 'Codex adapter process was terminated.' };
        if (child.status !== 0) {
          const details = [child.stdout, child.stderr].filter((value): value is string => typeof value === 'string' && value.length > 0).join('\n').trim();
          return { ok: false, error: `Codex adapter exited with code ${child.status}${details ? `: ${details.slice(0, 2000)}` : ''}.` };
        }
        if (!readFileExists(outputPath)) return { ok: false, error: 'Codex adapter did not produce a final message.' };

        const text = readFileSync(outputPath, 'utf8').trim();
        if (text === '') return { ok: false, error: 'Codex adapter produced an empty final message.' };
        const stdout = typeof child.stdout === 'string' ? child.stdout : '';
        const metadata = parseEvents(stdout);
        return {
          ok: true,
          text,
          providerId: 'codex',
          requestedModel: config.model,
          resolvedModel: metadata.resolvedModel ?? config.model,
          reasoningEffort: config.reasoningEffort,
          usage: metadata.usage
        };
      } finally {
        rmSync(tempDir, { recursive: true, force: true });
      }
    }
  };
}

// Codex Structured Outputs requires every object to opt out of unknown fields.
// This intentionally models the planner's provider-facing core only; optional
// routing and provenance are added deterministically after provider output is
// validated by the planner schema.
function planOutputSchema(): Record<string, unknown> {
  const criterion = {
    type: 'object', additionalProperties: false,
    required: ['criterionId', 'text'],
    properties: { criterionId: { type: 'string' }, text: { type: 'string' } }
  };
  const gate = {
    type: 'object', additionalProperties: false,
    required: ['gateId', 'command', 'evidenceContract', 'criterionIds'],
    properties: {
      gateId: { type: 'string' }, command: { type: 'string' }, evidenceContract: { type: 'string' },
      criterionIds: { type: 'array', items: { type: 'string' } }
    }
  };
  const scope = {
    type: 'object', additionalProperties: false,
    required: ['allowedPaths', 'forbiddenPaths'],
    properties: {
      allowedPaths: { type: 'array', items: { type: 'string' } },
      forbiddenPaths: { type: 'array', items: { type: 'string' } }
    }
  };
  const requiredInput = {
    type: 'object', additionalProperties: false,
    required: ['kind', 'ref'],
    properties: { kind: { type: 'string', enum: ['file', 'symbol', 'external'] }, ref: { type: 'string' } }
  };
  const task = {
    type: 'object', additionalProperties: false,
    required: ['id', 'goal', 'acceptanceCriteria', 'gates', 'dependsOn', 'scope', 'requiredInputs', 'risk'],
    properties: {
      id: { type: 'string' }, goal: { type: 'string' },
      acceptanceCriteria: { type: 'array', items: criterion },
      gates: { type: 'array', items: gate },
      dependsOn: { type: 'array', items: { type: 'string' } },
      scope,
      requiredInputs: { type: 'array', items: requiredInput },
      risk: { type: 'string', enum: ['low', 'medium', 'high'] }
    }
  };
  return {
    type: 'object', additionalProperties: false,
    required: ['goal', 'tasks'],
    properties: { goal: { type: 'string' }, tasks: { type: 'array', items: task } }
  };
}

function readFileExists(path: string): boolean {
  try {
    readFileSync(path, 'utf8');
    return true;
  } catch {
    return false;
  }
}
