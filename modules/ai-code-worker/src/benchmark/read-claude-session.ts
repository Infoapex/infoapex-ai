import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface ClaudeSessionTurnUsage {
  readonly inputTokens: number | null;
  readonly cacheReadTokens: number | null;
  readonly cacheCreationTokens: number | null;
  readonly outputTokens: number | null;
}

export interface ClaudeSessionUsageSummary {
  readonly turns: readonly ClaudeSessionTurnUsage[];
  /** Last turn's input_tokens + cache_read_input_tokens + cache_creation_input_tokens -
   *  NOT a sum over all turns (cache_read is reported per-turn as that turn's full
   *  prefix, so raw summation double-counts quadratically; confirmed against a live
   *  /context reading, see docs/HANDOFF-BENCHMARK-TOOL-AND-PHASE-4.md). Output tokens
   *  are excluded - they are not part of the next turn's input context. */
  readonly estimatedContextTokens: number | null;
}

interface ClaudeTranscriptLine {
  readonly type?: string;
  readonly message?: {
    readonly usage?: {
      readonly input_tokens?: unknown;
      readonly cache_read_input_tokens?: unknown;
      readonly cache_creation_input_tokens?: unknown;
      readonly output_tokens?: unknown;
    };
  };
}

/** Pure parser: scans a `~/.claude/projects/<hash>/<session-id>.jsonl` transcript's
 *  content for assistant turns and returns their per-turn usage, plus a current
 *  context-size estimate. Deliberately does NOT sum tokens across turns into a
 *  billing total - that is not meaningful for this file (see the field doc above). */
export function parseClaudeSessionLog(content: string): ClaudeSessionUsageSummary {
  const turns: ClaudeSessionTurnUsage[] = [];

  for (const line of content.split("\n")) {
    const trimmed = line.trim();

    if (!trimmed) {
      continue;
    }

    let parsed: ClaudeTranscriptLine;
    try {
      parsed = JSON.parse(trimmed) as ClaudeTranscriptLine;
    } catch {
      continue;
    }

    const usage = parsed.message?.usage;

    if (!usage) {
      continue;
    }

    turns.push({
      inputTokens: readNumber(usage.input_tokens),
      cacheReadTokens: readNumber(usage.cache_read_input_tokens),
      cacheCreationTokens: readNumber(usage.cache_creation_input_tokens),
      outputTokens: readNumber(usage.output_tokens)
    });
  }

  const last = turns.at(-1) ?? null;
  const estimatedContextTokens =
    last && (last.inputTokens !== null || last.cacheReadTokens !== null || last.cacheCreationTokens !== null)
      ? (last.inputTokens ?? 0) + (last.cacheReadTokens ?? 0) + (last.cacheCreationTokens ?? 0)
      : null;

  return { turns, estimatedContextTokens };
}

/** Local session-log paths are outside the repository and outside $STATE_ROOT -
 *  best-effort, read-only: missing file, unreadable file, or unparseable content all
 *  fall back to null rather than throwing. */
export function readClaudeSessionLog(path: string): ClaudeSessionUsageSummary | null {
  try {
    if (!existsSync(path)) {
      return null;
    }

    return parseClaudeSessionLog(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

export interface FindClaudeSessionLogOptions {
  readonly claudeProjectsDir?: string;
  readonly homeDirectory?: string;
}

/** Finds `~/.claude/projects/<any-project-hash>/<sessionId>.jsonl` by scanning every
 *  project directory for a matching session file, rather than recomputing Claude
 *  Code's own (undocumented, version-dependent) project-hash algorithm - robust to
 *  that algorithm changing. Returns null if the projects directory doesn't exist or
 *  no project has that session (e.g. a headless run made with
 *  --no-session-persistence, which - per the Claude adapter's own design - never
 *  writes a transcript here at all). */
export function findClaudeSessionLogPath(sessionId: string, options: FindClaudeSessionLogOptions = {}): string | null {
  const root = options.claudeProjectsDir ?? join(options.homeDirectory ?? homedir(), ".claude", "projects");

  if (!existsSync(root)) {
    return null;
  }

  for (const projectDir of readdirSync(root)) {
    const candidate = join(root, projectDir, `${sessionId}.jsonl`);

    if (existsSync(candidate) && statSync(candidate).isFile()) {
      return candidate;
    }
  }

  return null;
}

function readNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
