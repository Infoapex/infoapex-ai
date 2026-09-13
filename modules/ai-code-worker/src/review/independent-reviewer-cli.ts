import { randomUUID } from "node:crypto";
import { type SpawnSyncReturns } from "node:child_process";
import { candidateAgentResultObjects } from "../engines/claude-cli.js";
import { lastAgentMessageText, parseAgentResultText } from "../engines/codex-cli.js";
import { needsShellWrapper } from "../engines/spawn-shell.js";
import { git } from "../git/diff.js";
import type { IndependentReviewer } from "../run/independent-review-repair.js";
import { SchemaRegistry } from "../schema/json-schema.js";
import { buildReviewPrompt, type ReviewPromptTask } from "./build-review-prompt.js";
import type { IndependentReviewResult } from "./independent-review.js";
import { localEngineProcessRunner, type EngineProcessRunner } from "../engines/process-runner.js";

export interface IndependentReviewerCliConfig {
  readonly executable?: string;
  readonly baseArgs?: readonly string[];
  readonly defaultModel?: string | null;
  readonly timeoutMs?: number;
  readonly maximumOutputBytes?: number;
  /** Injected by an execution backend; omitted only for direct test fixtures. */
  /** null explicitly means the configured production boundary is unavailable. */
  readonly processRunner?: EngineProcessRunner | null;
}

export interface CreateIndependentReviewerOptions {
  readonly repositoryPath: string;
  readonly baseCommit: string;
  readonly tasks: readonly ReviewPromptTask[];
  readonly config?: IndependentReviewerCliConfig;
  readonly registry?: SchemaRegistry;
  /** Injectable clock for deterministic tests; defaults to the real clock. */
  readonly now?: () => string;
  readonly context?: string;
}

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_MAXIMUM_OUTPUT_BYTES = 1024 * 1024;

/**
 * IMPLEMENTATION-PLAN.md §9.3 / §12.1 / §12.2: a real independent review call - a
 * fresh, read-only invocation of Claude or Codex, with no access to the implementer's
 * conversation, that returns findings validated against independent-review.schema.json.
 * This is deliberately standalone rather than built on ClaudeCliAdapter/CodexCliAdapter
 * (both hardcode agent-result.schema.json validation in their own start()) - reusing
 * only the schema-agnostic prose/JSON extraction helpers those adapters already export
 * (candidateAgentResultObjects, lastAgentMessageText/parseAgentResultText).
 *
 * todo.md #9's other half - actually EXECUTING a repair task with a real engine - is
 * NOT built here. A caller that wires this reviewer in without a real repair executor
 * gets a real review with real findings; if those findings are blocking, repair cycles
 * exhaust immediately (see noRepairCapabilityExecutor in independent-review-wiring.ts)
 * and the run BLOCKS with the real findings, rather than silently claiming automated
 * repair that does not exist.
 */
export function createClaudeIndependentReviewer(options: CreateIndependentReviewerOptions): IndependentReviewer {
  const registry = options.registry ?? SchemaRegistry.load();
  const config = options.config ?? {};
  const executable = config.executable ?? "claude";
  const baseArgs = config.baseArgs ?? [];
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maximumOutputBytes = config.maximumOutputBytes ?? DEFAULT_MAXIMUM_OUTPUT_BYTES;
  const processRunner = config.processRunner === null ? null : config.processRunner ?? localEngineProcessRunner;
  const now = options.now ?? (() => new Date().toISOString());

  return (context) => {
    const reviewId = `${context.runId}-review-${randomUUID().slice(0, 8)}`;
    const createdAt = now();
    if (!processRunner) {
      return engineFailureResult(context.runId, reviewId, context.graphVersion, createdAt, "claude", "The configured execution environment does not provide an isolated Claude reviewer process runner.");
    }
    const diffsByTask = buildDiffsByTask(options.repositoryPath, options.baseCommit, context.taskCommits, options.tasks);
    const prompt = buildReviewPrompt({
      runId: context.runId,
      reviewId,
      graphVersion: context.graphVersion,
      createdAt,
      tasks: options.tasks,
      diffsByTask,
      context: options.context
    });

    const args = [
      ...baseArgs,
      "-p",
      "--no-session-persistence",
      "--input-format",
      "text",
      "--output-format",
      "json",
      "--session-id",
      randomUUID(),
      // Read-only: no Edit/Write in either flag, matching §9.3 ("read-only") and
      // §12.1's explicit "reviewerul folosesc read-only" for the Codex counterpart.
      "--tools",
      "Read,Grep,Glob",
      "--allowedTools",
      "Read,Grep,Glob",
      "--permission-mode",
      "dontAsk"
    ];

    if (config.defaultModel) {
      args.push("--model", config.defaultModel);
    }

    const child = processRunner.runSync(executable, args, {
      cwd: options.repositoryPath,
      input: prompt,
      maximumOutputBytes,
      timeoutMs,
      shell: needsShellWrapper(executable)
    });

    return parseClaudeReviewChild(child, registry, context.runId, reviewId, context.graphVersion, createdAt);
  };
}

export function createCodexIndependentReviewer(options: CreateIndependentReviewerOptions): IndependentReviewer {
  const registry = options.registry ?? SchemaRegistry.load();
  const config = options.config ?? {};
  const executable = config.executable ?? "codex";
  const baseArgs = config.baseArgs ?? [];
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maximumOutputBytes = config.maximumOutputBytes ?? DEFAULT_MAXIMUM_OUTPUT_BYTES;
  const processRunner = config.processRunner === null ? null : config.processRunner ?? localEngineProcessRunner;
  const now = options.now ?? (() => new Date().toISOString());

  return (context) => {
    const reviewId = `${context.runId}-review-${randomUUID().slice(0, 8)}`;
    const createdAt = now();
    if (!processRunner) {
      return engineFailureResult(context.runId, reviewId, context.graphVersion, createdAt, "codex", "The configured execution environment does not provide an isolated Codex reviewer process runner.");
    }
    const diffsByTask = buildDiffsByTask(options.repositoryPath, options.baseCommit, context.taskCommits, options.tasks);
    const prompt = buildReviewPrompt({
      runId: context.runId,
      reviewId,
      graphVersion: context.graphVersion,
      createdAt,
      tasks: options.tasks,
      diffsByTask,
      context: options.context
    });

    const args = [
      ...baseArgs,
      "exec",
      "--ignore-user-config",
      "--ignore-rules",
      "--json",
      "--cd",
      options.repositoryPath,
      // §12.1: "Plan compiler-ul și reviewerul folosesc read-only." - unlike the
      // implementer role's workspace-write, this never needs write access.
      "--sandbox",
      "read-only",
      "-"
    ];

    if (config.defaultModel) {
      args.push("--model", config.defaultModel);
    }

    const child = processRunner.runSync(executable, args, {
      cwd: options.repositoryPath,
      input: prompt,
      maximumOutputBytes,
      timeoutMs,
      shell: needsShellWrapper(executable)
    });

    return parseCodexReviewChild(child, registry, context.runId, reviewId, context.graphVersion, createdAt);
  };
}

function buildDiffsByTask(
  repositoryPath: string,
  baseCommit: string,
  taskCommits: Readonly<Record<string, string>>,
  tasks: readonly ReviewPromptTask[]
): Record<string, string> {
  const diffs: Record<string, string> = {};

  for (const task of tasks) {
    const commit = taskCommits[task.id];

    if (!commit) {
      continue;
    }

    diffs[task.id] = git(["diff", baseCommit, commit], repositoryPath);
  }

  return diffs;
}

function parseClaudeReviewChild(
  child: SpawnSyncReturns<string>,
  registry: SchemaRegistry,
  runId: string,
  reviewId: string,
  graphVersion: number,
  createdAt: string
): IndependentReviewResult {
  if (child.status === 0 && typeof child.stdout === "string") {
    try {
      const envelope = JSON.parse(child.stdout) as { readonly result?: unknown };
      const text = typeof envelope.result === "string" ? envelope.result : JSON.stringify(envelope.result);

      for (const candidate of candidateAgentResultObjects(text)) {
        try {
          registry.assertValid("independent-review.schema.json", candidate);
          return candidate as IndependentReviewResult;
        } catch {
          continue;
        }
      }
    } catch {
      // fall through to the engine-failure result below
    }
  }

  return engineFailureResult(runId, reviewId, graphVersion, createdAt, "claude", childFailureMessage(child));
}

function parseCodexReviewChild(
  child: SpawnSyncReturns<string>,
  registry: SchemaRegistry,
  runId: string,
  reviewId: string,
  graphVersion: number,
  createdAt: string
): IndependentReviewResult {
  if (child.status === 0 && typeof child.stdout === "string") {
    const lastMessage = lastAgentMessageText(child.stdout);

    if (lastMessage !== null) {
      try {
        const candidate = parseAgentResultText(lastMessage);
        registry.assertValid("independent-review.schema.json", candidate);
        return candidate as IndependentReviewResult;
      } catch {
        // fall through to the engine-failure result below
      }
    }
  }

  return engineFailureResult(runId, reviewId, graphVersion, createdAt, "codex", childFailureMessage(child));
}

function engineFailureResult(
  runId: string,
  reviewId: string,
  graphVersion: number,
  createdAt: string,
  reviewer: string,
  reason: string
): IndependentReviewResult {
  // Fail-closed: an engine/parse failure produces a "fail" verdict with a blocking
  // finding, never a silent "pass" - the same guardrail as unknownUsage() in
  // claude-cli.ts/codex-cli.ts (todo.md #11), applied to review outcomes instead of
  // token accounting.
  return {
    schemaVersion: "1.0",
    runId,
    reviewId,
    reviewer,
    graphVersion,
    createdAt,
    verdict: "fail",
    criterionCoverage: [],
    findings: [
      {
        id: "REV-ENGINE-FAILURE",
        severity: "blocking",
        category: "engine",
        criterionIds: [],
        files: [],
        evidence: reason
      }
    ]
  };
}

function childFailureMessage(child: SpawnSyncReturns<string>): string {
  const output = [
    typeof child.stdout === "string" ? child.stdout : "",
    typeof child.stderr === "string" ? child.stderr : "",
    child.error?.message ?? ""
  ]
    .filter((part) => part.length > 0)
    .join("\n")
    .trim();

  return output.length > 0 ? output.slice(0, 4000) : "The reviewer engine did not produce a schema-valid independent review.";
}
