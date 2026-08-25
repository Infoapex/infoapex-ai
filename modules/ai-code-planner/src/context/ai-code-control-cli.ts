import { spawnSync } from 'node:child_process';
import type { PlannerContext } from './types.js';

export interface AiCodeControlContextOptions {
  readonly repositoryPath: string;
  readonly executable?: string;
  readonly timeoutMs?: number;
  readonly maximumOutputBytes?: number;
  readonly symbols?: readonly string[];
}

export function collectPlannerContext(options: AiCodeControlContextOptions): PlannerContext {
  const executable = options.executable ?? 'ai-code-control';
  const timeoutMs = options.timeoutMs ?? 30_000;
  const maximumOutputBytes = options.maximumOutputBytes ?? 1_000_000;
  const warnings: string[] = [];
  const health = runJson(executable, ['health-check'], options.repositoryPath, timeoutMs, maximumOutputBytes);

  if (health.status === 'UNAVAILABLE') {
    return { status: 'UNAVAILABLE', provider: 'ai-code-control', warnings: [health.reason] };
  }
  if (health.status === 'ERROR') {
    warnings.push(health.reason);
  }

  const brief = runText(executable, ['memory-brief', 'planning'], options.repositoryPath, timeoutMs, maximumOutputBytes);
  if (brief.status !== 'OK') warnings.push(brief.reason);

  const symbolMatches: Array<{ symbol: string; file: string; line: number | null }> = [];
  const impacts: Array<{ symbol: string; affectedFiles: readonly string[]; riskNotes: readonly string[] }> = [];
  for (const symbol of options.symbols ?? []) {
    const found = runJson(executable, ['find-symbol', symbol], options.repositoryPath, timeoutMs, maximumOutputBytes);
    if (found.status === 'OK') {
      const body = asRecord(found.value);
      const matches = Array.isArray(body.matches) ? body.matches : Array.isArray(found.value) ? found.value : [];
      for (const item of matches) {
        const record = asRecord(item);
        if (typeof record.symbol === 'string' && typeof record.file === 'string') {
          symbolMatches.push({ symbol: record.symbol, file: record.file, line: typeof record.line === 'number' ? record.line : null });
        }
      }
    } else {
      warnings.push(`${symbol}: ${found.reason}`);
    }

    const impact = runJson(executable, ['impact-analysis', symbol], options.repositoryPath, timeoutMs, maximumOutputBytes);
    if (impact.status === 'OK') {
      const body = asRecord(impact.value);
      impacts.push({
        symbol,
        affectedFiles: asStringArray(body.affectedFiles),
        riskNotes: asStringArray(body.riskNotes)
      });
    } else {
      warnings.push(`${symbol}: ${impact.reason}`);
    }
  }

  return {
    status: warnings.length > 0 && brief.status !== 'OK' ? 'ERROR' : 'OK',
    provider: 'ai-code-control',
    health: health.status === 'OK' ? formatHealth(health.value) : undefined,
    brief: brief.status === 'OK' ? String(brief.value) : undefined,
    symbolMatches,
    impacts,
    warnings
  };
}

type CommandResult =
  | { readonly status: 'OK'; readonly value: unknown }
  | { readonly status: 'UNAVAILABLE' | 'ERROR'; readonly reason: string };

function runJson(executable: string, args: readonly string[], cwd: string, timeoutMs: number, maximumOutputBytes: number): CommandResult {
  const result = run(executable, args, cwd, timeoutMs, maximumOutputBytes);
  if (result.status !== 'OK') return result;
  try {
    return { status: 'OK', value: JSON.parse(result.stdout) };
  } catch {
    return { status: 'ERROR', reason: `${args[0]} did not return valid JSON` };
  }
}

function runText(executable: string, args: readonly string[], cwd: string, timeoutMs: number, maximumOutputBytes: number): CommandResult {
  const result = run(executable, args, cwd, timeoutMs, maximumOutputBytes);
  return result.status === 'OK' ? { status: 'OK', value: result.stdout.trim() } : result;
}

function run(executable: string, args: readonly string[], cwd: string, timeoutMs: number, maximumOutputBytes: number):
  | { readonly status: 'OK'; readonly stdout: string }
  | { readonly status: 'UNAVAILABLE' | 'ERROR'; readonly reason: string } {
  const child = spawnSync(executable, args, {
    cwd,
    encoding: 'utf8',
    timeout: timeoutMs,
    maxBuffer: maximumOutputBytes,
    windowsHide: true,
    shell: process.platform === 'win32' && /\.(cmd|bat)$/i.test(executable)
  });
  if (child.error) {
    const code = (child.error as NodeJS.ErrnoException).code;
    return { status: code === 'ENOENT' ? 'UNAVAILABLE' : 'ERROR', reason: child.error.message };
  }
  if (child.signal !== null || child.status === null) return { status: 'ERROR', reason: `${args[0]} timed out or was terminated` };
  if (child.status !== 0) return { status: 'ERROR', reason: `${args[0]} exited with code ${child.status}` };
  const stdout = typeof child.stdout === 'string' ? child.stdout : '';
  if (Buffer.byteLength(stdout, 'utf8') > maximumOutputBytes) return { status: 'ERROR', reason: `${args[0]} exceeded output limit` };
  return { status: 'OK', stdout };
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' ? value as Record<string, unknown> : {};
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function formatHealth(value: unknown): string {
  const body = asRecord(value);
  return typeof body.status === 'string' ? body.status : 'available';
}
