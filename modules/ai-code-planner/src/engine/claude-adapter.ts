import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';

/**
 * Windows cannot execute .cmd/.bat files directly via CreateProcess -- spawnSync given
 * a full path to one, without shell:true, fails with EINVAL. Relevant beyond test
 * fixtures: a real --claude-executable override pointed at an npm-global .cmd shim
 * (common on Windows) would hit the same failure. Scoped to only .cmd/.bat executables
 * (not enabled unconditionally) because shell:true joins [executable, ...args] into a
 * single string for cmd.exe without quoting the executable portion, which breaks an
 * executable path containing spaces (e.g. "C:\Program Files\nodejs\node.exe").
 * Mechanics copied from ai-code-worker's src/engines/spawn-shell.ts (ADR-0004 /
 * _FINAL.md decision 13: copying is authorized, importing the module is not).
 */
function needsShellWrapper(executable: string): boolean {
  return process.platform === 'win32' && /\.(cmd|bat)$/i.test(executable);
}

export interface ClaudeAdapterConfig {
  readonly executable?: string;
  readonly baseArgs?: readonly string[];
  readonly cwd?: string;
  readonly defaultModel?: string | null;
  readonly timeoutMs?: number;
  readonly maximumOutputBytes?: number;
}

export interface ClaudeUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
}

export type AskResult =
  | { ok: true; text: string; resolvedModel: string | null; usage: ClaudeUsage }
  | { ok: false; error: string };

export interface ClaudeAdapter {
  ask(prompt: string): AskResult;
}

interface ClaudeEnvelopeUsage {
  readonly input_tokens?: unknown;
  readonly output_tokens?: unknown;
  readonly cache_read_input_tokens?: unknown;
  readonly cache_creation_input_tokens?: unknown;
}

interface ClaudeEnvelope {
  readonly result?: unknown;
  readonly usage?: ClaudeEnvelopeUsage;
  readonly model?: unknown;
  readonly modelUsage?: Record<string, unknown>;
}

function readInt(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : 0;
}

function resolveModel(envelope: ClaudeEnvelope): string | null {
  if (envelope.modelUsage != null) {
    const keys = Object.keys(envelope.modelUsage);
    const firstKey = keys[0];
    if (firstKey !== undefined) {
      return firstKey;
    }
  }
  if (typeof envelope.model === 'string') {
    return envelope.model;
  }
  return null;
}

export function createClaudeAdapter(config: ClaudeAdapterConfig): ClaudeAdapter {
  const executable = config.executable ?? 'claude';
  const baseArgs = config.baseArgs ?? [];
  const cwd = config.cwd;
  const defaultModel = config.defaultModel ?? null;
  const timeoutMs = config.timeoutMs ?? 60_000;
  const maximumOutputBytes = config.maximumOutputBytes ?? 1024 * 1024;

  return {
    ask(prompt: string): AskResult {
      const args: string[] = [
        ...baseArgs,
        '-p',
        '--no-session-persistence',
        '--input-format', 'text',
        '--output-format', 'json',
        '--session-id', randomUUID(),
        ...(defaultModel != null ? ['--model', defaultModel] : [])
      ];

      const child = spawnSync(executable, args, {
        input: prompt,
        ...(cwd !== undefined ? { cwd } : {}),
        encoding: 'utf8',
        timeout: timeoutMs,
        maxBuffer: maximumOutputBytes,
        windowsHide: true,
        shell: needsShellWrapper(executable)
      });

      if (child.error) {
        const code = (child.error as NodeJS.ErrnoException).code;
        if (code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
          return { ok: false, error: `Claude adapter output exceeded ${maximumOutputBytes} bytes.` };
        }
        if (code === 'ETIMEDOUT') {
          return { ok: false, error: `Claude adapter timed out after ${timeoutMs}ms.` };
        }
        return { ok: false, error: `Claude adapter spawn error: ${child.error.message}` };
      }

      if (child.signal !== null) {
        return { ok: false, error: `Claude adapter process killed with signal ${child.signal} (timeout after ${timeoutMs}ms).` };
      }

      if (child.status !== 0) {
        const output = [child.stdout, child.stderr]
          .filter((s): s is string => typeof s === 'string' && s.length > 0)
          .join('\n')
          .trim();
        return {
          ok: false,
          error: `Claude adapter exited with code ${child.status}${output ? ': ' + output.slice(0, 2000) : ''}.`
        };
      }

      const stdout = child.stdout;
      if (typeof stdout !== 'string' || stdout.trim() === '') {
        return { ok: false, error: 'Claude adapter produced no output.' };
      }

      let envelope: ClaudeEnvelope;
      try {
        envelope = JSON.parse(stdout) as ClaudeEnvelope;
      } catch {
        return { ok: false, error: `Claude adapter output was not valid JSON: ${stdout.slice(0, 200)}` };
      }

      if (typeof envelope.result !== 'string') {
        return { ok: false, error: 'Claude adapter envelope missing string "result" field.' };
      }

      const usage = envelope.usage ?? {};

      return {
        ok: true,
        text: envelope.result,
        resolvedModel: resolveModel(envelope),
        usage: {
          inputTokens: readInt(usage.input_tokens),
          outputTokens: readInt(usage.output_tokens),
          cacheReadTokens: readInt(usage.cache_read_input_tokens),
          cacheCreationTokens: readInt(usage.cache_creation_input_tokens)
        }
      };
    }
  };
}
