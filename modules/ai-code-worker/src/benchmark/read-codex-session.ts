import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface CodexSessionTokenUsage {
  readonly inputTokens: number | null;
  readonly cachedInputTokens: number | null;
  /** Present on real CLI 0.147.0 rollouts as of 2026-09-02 (P2-B live run); older
   *  sanitized fixtures captured before that date omit it, in which case this is null
   *  the same way any other absent field would be - not a permanent CLI limitation. */
  readonly cacheWriteTokens: number | null;
  readonly outputTokens: number | null;
  readonly totalTokens: number | null;
}

export interface CodexSessionUsageSummary {
  readonly totalTokenUsage: CodexSessionTokenUsage | null;
  /** `rate_limits.primary` - the short rolling window (300 minutes = 5h on every
   *  real rollout observed so far). */
  readonly usedPercent: number | null;
  readonly windowMinutes: number | null;
  readonly resetsAt: number | null;
  /** `rate_limits.secondary` - the long rolling window (10080 minutes = 7 days on
   *  every real rollout observed so far). Added 2026-09-02; older sanitized fixtures
   *  predating that date don't have it, same "absent, not unsupported" convention as
   *  cacheWriteTokens above. */
  readonly secondaryUsedPercent: number | null;
  readonly secondaryWindowMinutes: number | null;
  readonly secondaryResetsAt: number | null;
  readonly planType: string | null;
  readonly sessionId: string | null;
  readonly model: string | null;
  readonly reasoningEffort: string | null;
  readonly modelContextWindow: number | null;
}

interface CodexRolloutEvent {
  readonly timestamp?: string;
  readonly type?: string;
  readonly payload?: {
    readonly type?: string;
    readonly session_id?: unknown;
    readonly context_window?: unknown;
    readonly model?: unknown;
    readonly effort?: unknown;
    readonly model_context_window?: unknown;
    readonly info?: {
      readonly total_token_usage?: {
        readonly input_tokens?: unknown;
        readonly cached_input_tokens?: unknown;
        readonly cache_write_input_tokens?: unknown;
        readonly output_tokens?: unknown;
        readonly total_tokens?: unknown;
      };
    };
    readonly rate_limits?: {
      readonly primary?: {
        readonly used_percent?: unknown;
        readonly window_minutes?: unknown;
        readonly resets_at?: unknown;
      };
      readonly secondary?: {
        readonly used_percent?: unknown;
        readonly window_minutes?: unknown;
        readonly resets_at?: unknown;
      };
      readonly plan_type?: unknown;
    };
  };
}

const EMPTY_SUMMARY: CodexSessionUsageSummary = {
  totalTokenUsage: null,
  usedPercent: null,
  windowMinutes: null,
  resetsAt: null,
  secondaryUsedPercent: null,
  secondaryWindowMinutes: null,
  secondaryResetsAt: null,
  planType: null,
  sessionId: null,
  model: null,
  reasoningEffort: null,
  modelContextWindow: null
};

/** Pure parser: scans a `~/.codex/sessions/**\/rollout-*.jsonl` file's content for
 *  event_msg/token_count lines and returns the LAST one - total_token_usage is
 *  already cumulative for the whole session, and rate_limits.primary.used_percent is
 *  the direct Codex equivalent of Claude's /usage percentage (confirmed live, see
 *  docs/HANDOFF-BENCHMARK-TOOL-AND-PHASE-4.md). No summing across events. */
export function parseCodexSessionLog(content: string): CodexSessionUsageSummary {
  let last: CodexSessionUsageSummary = EMPTY_SUMMARY;
  let sessionId: string | null = null;
  let model: string | null = null;
  let reasoningEffort: string | null = null;
  let modelContextWindow: number | null = null;

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

    if (event.type === "session_meta") {
      sessionId = readString(event.payload?.session_id) ?? sessionId;
      modelContextWindow = readNumber(event.payload?.context_window) ?? modelContextWindow;
      continue;
    }

    if (event.type === "turn_context") {
      model = readString(event.payload?.model) ?? model;
      reasoningEffort = readString(event.payload?.effort) ?? reasoningEffort;
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
            cacheWriteTokens: readNumber(totals.cache_write_input_tokens),
            outputTokens: readNumber(totals.output_tokens),
            totalTokens: readNumber(totals.total_tokens)
          }
        : last.totalTokenUsage,
      usedPercent: rateLimits?.primary ? readNumber(rateLimits.primary.used_percent) : last.usedPercent,
      windowMinutes: rateLimits?.primary ? readNumber(rateLimits.primary.window_minutes) : last.windowMinutes,
      resetsAt: rateLimits?.primary ? readNumber(rateLimits.primary.resets_at) : last.resetsAt,
      secondaryUsedPercent: rateLimits?.secondary ? readNumber(rateLimits.secondary.used_percent) : last.secondaryUsedPercent,
      secondaryWindowMinutes: rateLimits?.secondary ? readNumber(rateLimits.secondary.window_minutes) : last.secondaryWindowMinutes,
      secondaryResetsAt: rateLimits?.secondary ? readNumber(rateLimits.secondary.resets_at) : last.secondaryResetsAt,
      planType: typeof rateLimits?.plan_type === "string" ? rateLimits.plan_type : last.planType,
      sessionId,
      model,
      reasoningEffort,
      modelContextWindow: readNumber(event.payload.model_context_window) ?? modelContextWindow
    };
  }

  return { ...last, sessionId, model, reasoningEffort, modelContextWindow };
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

/** Returns rollout files modified during a bounded development stage. This is used
 *  only to flag that an account-level rate-limit percentage may include another
 *  Codex session; file content is never persisted by the benchmark. */
export function findCodexRolloutsModifiedSince(
  since: Date,
  options: FindLatestCodexRolloutOptions = {},
  until: Date = new Date()
): readonly string[] {
  const root = options.codexSessionsDir ?? join(options.homeDirectory ?? homedir(), ".codex", "sessions");

  if (!existsSync(root)) {
    return [];
  }

  return walkJsonlFiles(root)
    .filter((path) => /rollout-/.test(path))
    .filter((path) => {
      const modifiedAt = statSync(path).mtimeMs;
      return modifiedAt >= since.getTime() && modifiedAt <= until.getTime();
    })
    .sort();
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

function readString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}
