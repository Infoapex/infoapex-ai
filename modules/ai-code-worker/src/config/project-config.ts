import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface AdapterProjectConfig {
  readonly executable?: string;
  readonly baseArgs?: readonly string[];
  readonly model?: string | null;
  readonly timeoutSeconds?: number;
  /** Maximum silence without semantic provider output or a worktree mutation. */
  readonly idleTimeoutSeconds?: number;
  /** High circuit breaker for an invocation. Never use this as a performance target. */
  readonly maximumRuntimeSeconds?: number;
  /** Consecutive identical semantic provider actions tolerated before fail-closed stop. */
  readonly maximumRepeatedProgressEvents?: number;
  readonly maximumOutputBytes?: number;
  readonly testedVersionRanges?: readonly string[];
}

export interface CodexProjectAdapterConfig extends AdapterProjectConfig {
  readonly sandboxMode?: "workspace-write" | "danger-full-access";
  readonly reasoningEffort?: "none" | "low" | "medium" | "high" | "xhigh" | "max";
}

export interface ClaudeProjectAdapterConfig extends AdapterProjectConfig {
  readonly permissionMode?: "default" | "auto" | "plan" | "acceptEdits" | "bypassPermissions" | "dontAsk";
  readonly allowedTools?: readonly string[];
  readonly bareMode?: boolean;
  readonly dangerouslySkipPermissions?: boolean;
}

export interface ProjectConfig {
  readonly maximumParallelWriters?: number;
  readonly stateRoot?: string | null;
  /**
   * Optional external context provider (AICW-ADR-001 §5). Default "none" - the worker
   * must behave identically without it. "ai-code-control" is a subprocess CLI/JSON
   * adapter only, never a direct dependency.
   */
  readonly contextProvider?: "none" | "ai-code-control";
  readonly contextPackage?: {
    readonly mode: "off" | "observe" | "enforce";
    readonly maximumTokens: number;
  };
  /**
   * "Regula configurată" gate for the redacted handoff export (AICW-ADR-001 / plan
   * §13 invariant). Default false - exporting into `.ai-code-control/handoffs/` is
   * always explicit opt-in, never automatic just because a provider is configured.
   */
  readonly handoffExport?: boolean;
  readonly syncRootPolicy?: {
    readonly sequentialWriter: "warn" | "block";
    readonly parallelWriters: "warn" | "block";
  };
  readonly adapters?: {
    readonly codex?: CodexProjectAdapterConfig;
    readonly claude?: ClaudeProjectAdapterConfig;
    readonly aiCodeControl?: AdapterProjectConfig;
  };
}

export function loadProjectConfig(repositoryRoot: string): ProjectConfig | null {
  const path = join(repositoryRoot, ".ai-code-worker", "config.json");

  if (!existsSync(path)) {
    return null;
  }

  return JSON.parse(readFileSync(path, "utf8")) as ProjectConfig;
}
