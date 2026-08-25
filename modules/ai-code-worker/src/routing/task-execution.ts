import type { ProjectConfig } from "../config/project-config.js";
import { ClaudeCliAdapter, type ClaudeCliAdapterConfig, type ClaudeExecution } from "../engines/claude-cli.js";
import { CodexCliAdapter, type CodexCliAdapterConfig, type CodexExecution } from "../engines/codex-cli.js";
import type { RoutingCandidate } from "./routing-policy.js";

export type RoutedExecution = ClaudeExecution | CodexExecution;
export type RoutedEngine = "codex" | "claude";

export interface TaskExecutionRequest {
  readonly runId: string;
  readonly taskId: string;
  readonly executionId: string;
  readonly sessionId: string;
  readonly worktreePath: string;
  readonly prompt: string;
  readonly startedAt: string;
}

export interface TaskExecutionAttempt {
  readonly candidate: RoutingCandidate;
  readonly execution: RoutedExecution;
  readonly availabilityFailure: boolean;
}

export interface RoutedTaskExecution {
  readonly candidate: RoutingCandidate;
  readonly execution: RoutedExecution;
  readonly attempts: readonly TaskExecutionAttempt[];
}

export interface RoutedAdapter {
  readonly doctor: () => { readonly status: "PASS" | "BLOCKED"; readonly findings: readonly { readonly message: string }[] };
  readonly start: (request: TaskExecutionRequest) => RoutedExecution;
}

export function executeTaskWithFallback(input: {
  readonly candidates: readonly RoutingCandidate[];
  readonly projectConfig: ProjectConfig | null;
  readonly request: TaskExecutionRequest;
  readonly codexOverrides?: Partial<CodexCliAdapterConfig>;
  readonly claudeOverrides?: Partial<ClaudeCliAdapterConfig>;
  readonly adapterFactory?: (candidate: RoutingCandidate) => RoutedAdapter;
}): RoutedTaskExecution {
  const attempts: TaskExecutionAttempt[] = [];

  for (let index = 0; index < input.candidates.length; index += 1) {
    const candidate = input.candidates[index]!;
    const adapter = input.adapterFactory?.(candidate) ?? createAdapter(candidate, input.projectConfig, input.codexOverrides, input.claudeOverrides) as unknown as RoutedAdapter;
    const doctor = adapter.doctor();
    if (doctor.status === "BLOCKED") {
      const execution = failedExecution(input.request, candidate, doctor.findings[0]?.message ?? `${candidate.engine} is unavailable.`);
      const attempt = { candidate, execution, availabilityFailure: true };
      attempts.push(attempt);
      continue;
    }

    const execution = adapter.start({
      ...input.request,
      executionId: `${input.request.executionId}-candidate-${index + 1}`,
      sessionId: `${input.request.sessionId}-candidate-${index + 1}`
    });
    const availabilityFailure = isAvailabilityFailure(execution);
    const attempt = { candidate, execution, availabilityFailure };
    attempts.push(attempt);
    if (!availabilityFailure || execution.result.status === "DONE" || index === input.candidates.length - 1) {
      return { candidate, execution, attempts };
    }
  }

  const last = attempts.at(-1);
  if (!last) throw new Error("No routing candidates were configured for the task.");
  return { candidate: last.candidate, execution: last.execution, attempts };
}

export function isAvailabilityFailure(execution: RoutedExecution): boolean {
  if (execution.result.status === "DONE") return false;
  if (!execution.result.failures.some(failure => failure.class === "engine")) return false;
  const text = execution.result.failures.map(failure => failure.message).join(" ").toLowerCase();
  return /(quota|rate.?limit|too many requests|insufficient|credits|credit balance|usage limit|capacity|temporarily unavailable|service unavailable|overloaded|timeout|timed out|429|503|read.?only|sandbox|permission denied|approval|auto.?denied|write access|filesystem writes)/i.test(text);
}

function createAdapter(
  candidate: RoutingCandidate,
  projectConfig: ProjectConfig | null,
  codexOverrides: Partial<CodexCliAdapterConfig> | undefined,
  claudeOverrides: Partial<ClaudeCliAdapterConfig> | undefined
): ClaudeCliAdapter | CodexCliAdapter {
  if (candidate.engine === "codex") {
    return new CodexCliAdapter({
      requiresCapabilitySmokeTest: true,
      ...codexProjectConfig(projectConfig),
      ...(candidate.model !== null ? { defaultModel: candidate.model } : {}),
      ...codexOverrides
    });
  }
  return new ClaudeCliAdapter({
    requiresCapabilitySmokeTest: true,
    ...claudeProjectConfig(projectConfig),
    ...(candidate.model !== null ? { defaultModel: candidate.model } : {}),
    ...claudeOverrides
  });
}

function codexProjectConfig(config: ProjectConfig | null): Partial<CodexCliAdapterConfig> {
  const source = config?.adapters?.codex;
  return {
    ...(source?.executable !== undefined ? { executable: source.executable } : {}),
    ...(source?.sandboxMode !== undefined ? { sandboxMode: source.sandboxMode } : {}),
    ...(source?.testedVersionRanges !== undefined ? { testedVersionRanges: source.testedVersionRanges } : {}),
    ...(source?.timeoutSeconds !== undefined ? { timeoutMs: source.timeoutSeconds * 1000 } : {}),
    ...(source?.maximumOutputBytes !== undefined ? { maximumOutputBytes: source.maximumOutputBytes } : {})
  };
}

function claudeProjectConfig(config: ProjectConfig | null): Partial<ClaudeCliAdapterConfig> {
  const source = config?.adapters?.claude;
  return {
    ...(source?.executable !== undefined ? { executable: source.executable } : {}),
    ...(source?.permissionMode !== undefined ? { permissionMode: source.permissionMode } : {}),
    ...(source?.allowedTools !== undefined ? { allowedTools: source.allowedTools } : {}),
    ...(source?.bareMode !== undefined ? { bareMode: source.bareMode } : {}),
    ...(source?.dangerouslySkipPermissions !== undefined ? { dangerouslySkipPermissions: source.dangerouslySkipPermissions } : {}),
    ...(source?.testedVersionRanges !== undefined ? { testedVersionRanges: source.testedVersionRanges } : {}),
    ...(source?.timeoutSeconds !== undefined ? { timeoutMs: source.timeoutSeconds * 1000 } : {}),
    ...(source?.maximumOutputBytes !== undefined ? { maximumOutputBytes: source.maximumOutputBytes } : {})
  };
}

function failedExecution(request: TaskExecutionRequest, candidate: RoutingCandidate, message: string): RoutedExecution {
  const result = {
    schemaVersion: "1.0" as const,
    runId: request.runId,
    taskId: request.taskId,
    status: "FAILED" as const,
    summary: `${candidate.engine} is unavailable.`,
    touchedFiles: [],
    failures: [{ class: "engine" as const, message }]
  };
  return {
    executionId: request.executionId,
    sessionId: request.sessionId,
    events: [],
    usage: { inputUncachedTokens: null, cacheReadTokens: null, cacheWriteTokens: null, outputTokens: null, costUsd: null },
    result
  } as RoutedExecution;
}
