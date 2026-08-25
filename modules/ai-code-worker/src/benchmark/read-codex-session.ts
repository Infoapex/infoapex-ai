import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface CodexSessionTokenUsage {
  readonly inputTokens: number | null;
  readonly cachedInputTokens: number | null;
  readonly outputTokens: number | null;
  readonly totalTokens: number | null;
}

export interface CodexSessionUsageSummary {
  readonly totalTokenUsage: CodexSessionTokenUsage | null;
  readonly usedPercent: number | null;
  readonly windowMinutes: number | null;
  readonly planType: string | null;
}

interface CodexRolloutEvent {
  readonly type?: string;
  readonly payload?: {
    readonly type?: string;
    readonly info?: {
      readonly total_token_usage?: {
        readonly input_tokens?: unknown;
        readonly cached_input_tokens?: unknown;
        readonly output_tokens?: unknown;
        readonly total_tokens?: unknown;
      };
    };
    readonly rate_limits?: {
      readonly primary?: {
        readonly used_percent?: unknown;
        readonly window_minutes?: unknown;
      };
      readonly plan_type?: unknown;
    };
  };
}

const EMPTY_SUMMARY: CodexSessionUsageSummary = {
  totalTokenUsage: null,
  usedPercent: null,
  windowMinutes: null,
  planType: null
};

/** Pure parser: scans a `~/.codex/sessions/**\/rollout-*.jsonl` file's content for
 *  event_msg/token_count lines and returns the LAST one - total_token_usage is
 *  already cumulative for the whole session, and rate_limits.primary.used_percent is
 *  the direct Codex equivalent of Claude's /usage percentage (confirmed live, see
 *  docs/HANDOFF-BENCHMARK-TOOL-AND-PHASE-4.md). No summing across events. */
export function parseCodexSessionLog(content: string): CodexSessionUsageSummary {
  let last: CodexSessionUsageSummary = EMPTY_SUMMARY;

  for (const line of content.split("\n")) {
    const trimmed = line.trim();

    if (!trimmed) {
      continue;
    }

    let event: CodexRolloutEvent;
    try {
      event = JSON.parse(trimmed) as CodexRolloutEvent;
    } catch {
      continue;
    }

    if (event.type !== "event_msg" || event.payload?.type !== "token_count") {
      continue;
    }

    const totals = event.payload.info?.total_token_usage;
    const rateLimits = event.payload.rate_limits;

    last = {
      totalTokenUsage: totals
        ? {
            inputTokens: readNumber(totals.input_tokens),
            cachedInputTokens: readNumber(totals.cached_input_tokens),
            outputTokens: readNumber(totals.output_tokens),
            totalTokens: readNumber(totals.total_tokens)
          }
        : last.totalTokenUsage,
      usedPercent: rateLimits?.primary ? readNumber(rateLimits.primary.used_percent) : last.usedPercent,
      windowMinutes: rateLimits?.primary ? readNumber(rateLimits.primary.window_minutes) : last.windowMinutes,
      planType: typeof rateLimits?.plan_type === "string" ? rateLimits.plan_type : last.planType
    };
  }

  return last;
}

/** Local session-log paths are outside the repository and outside $STATE_ROOT -
 *  best-effort, read-only: missing file, unreadable file, or unparseable content all
 *  fall back to null rather than throwing. */
export function readCodexSessionLog(path: string): CodexSessionUsageSummary | null {
  try {
    if (!existsSync(path)) {
      return null;
    }

    return parseCodexSessionLog(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

export interface FindLatestCodexRolloutOptions {
  readonly codexSessionsDir?: string;
  readonly homeDirectory?: string;
}

/** Finds the most-recently-modified `rollout-*.jsonl` under
 *  `~/.codex/sessions/YYYY/MM/DD/` (default location; override via
 *  `codexSessionsDir` for tests or a non-default CODEX_HOME). Returns null rather
 *  than throwing if the directory doesn't exist - this CLI may not be installed, or
 *  may never have been run, on this machine. */
export function findLatestCodexRolloutPath(options: FindLatestCodexRolloutOptions = {}): string | null {
  const root = options.codexSessionsDir ?? join(options.homeDirectory ?? homedir(), ".codex", "sessions");

  if (!existsSync(root)) {
    return null;
  }

  let latestPath: string | null = null;
  let latestMtimeMs = -Infinity;

  for (const path of walkJsonlFiles(root)) {
    if (!path.endsWith(".jsonl") || !/rollout-/.test(path)) {
      continue;
    }

    const mtimeMs = statSync(path).mtimeMs;
    if (mtimeMs > latestMtimeMs) {
      latestMtimeMs = mtimeMs;
      latestPath = path;
    }
  }

  return latestPath;
}

function walkJsonlFiles(directory: string): string[] {
  const results: string[] = [];

  for (const entry of readdirSync(directory)) {
    const fullPath = join(directory, entry);
    const stats = statSync(fullPath);

    if (stats.isDirectory()) {
      results.push(...walkJsonlFiles(fullPath));
    } else if (stats.isFile()) {
      results.push(fullPath);
    }
  }

  return results;
}

function readNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
