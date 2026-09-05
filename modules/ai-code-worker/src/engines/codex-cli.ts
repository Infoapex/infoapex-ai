import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import type { AgentExecutionResult } from "./fake-engine.js";
import { createEngineEvent, validateEngineEventStream, type EngineEvent, type EngineUsage } from "./engine-event.js";
import { spawnBuffered, type BufferedProcessResult } from "./spawn-buffered.js";
import { needsShellWrapper } from "./spawn-shell.js";
import { versionMatchesAny } from "./version-match.js";
import { SchemaRegistry } from "../schema/json-schema.js";
import { discoverEngineExecutable } from "./discover-cli.js";

export { versionMatches, versionMatchesAny } from "./version-match.js";

export const REQUIRED_HELP_CAPABILITIES: readonly string[] = ["--json", "--cd", "--sandbox"];

export interface CodexCliAdapterConfig {
  readonly executable?: string;
  readonly baseArgs?: readonly string[];
  /** Optional compatibility override. When absent, behavioral smoke tests are the gate. */
  readonly testedVersionRanges?: readonly string[];
  readonly requiresCapabilitySmokeTest: boolean;
  readonly sandboxMode?: "workspace-write" | "danger-full-access";
  readonly adapterVersion?: string;
  readonly defaultModel?: string | null;
  readonly reasoningEffort?: "none" | "low" | "medium" | "high" | "xhigh" | "max";
  readonly timeoutMs?: number;
  /** Maximum silence without semantic output/worktree activity (default 3 minutes). */
  readonly idleTimeoutMs?: number;
  /** High safety circuit breaker (default 20 minutes), not a task-performance limit. */
  readonly maximumRuntimeMs?: number;
  /** Consecutive identical semantic actions allowed before loop protection stops the CLI. */
  readonly maximumRepeatedProgressEvents?: number;
  readonly maximumOutputBytes?: number;
}

export interface CodexDoctorReport {
  readonly status: "PASS" | "BLOCKED";
  readonly executable: string;
  readonly version: string | null;
  readonly parsedVersion: string | null;
  readonly testedVersion: boolean;
  readonly smokeTest: "PASS" | "BLOCKED" | "SKIPPED";
  readonly behavioralSmokeTest: "PASS" | "BLOCKED" | "SKIPPED";
  readonly findings: readonly CodexFinding[];
}

export interface CodexFinding {
  readonly severity: "blocker";
  readonly code: "CODEX_VERSION_UNAVAILABLE" | "CODEX_VERSION_UNTESTED" | "CODEX_SMOKE_TEST_FAILED" | "CODEX_BEHAVIORAL_SMOKE_TEST_FAILED";
  readonly message: string;
}

export interface CodexStartRequest {
  readonly runId: string;
  readonly taskId: string;
  readonly executionId: string;
  readonly sessionId: string;
  readonly worktreePath: string;
  readonly prompt: string;
  readonly startedAt: string;
}

export interface CodexExecution {
  readonly executionId: string;
  readonly sessionId: string;
  readonly events: readonly EngineEvent[];
  readonly usage: EngineUsage;
  readonly result: AgentExecutionResult;
}

export interface CodexExecInvocation {
  readonly executable: string;
  readonly args: readonly string[];
  readonly stdin: string;
}

export class CodexCliAdapter {
  private readonly executable: string;
  private readonly baseArgs: readonly string[];
  private readonly adapterVersion: string;
  private readonly timeoutMs: number;
  private readonly idleTimeoutMs: number;
  private readonly maximumRuntimeMs: number;
  private readonly maximumRepeatedProgressEvents: number;
  private readonly maximumOutputBytes: number;

  constructor(
    private readonly config: CodexCliAdapterConfig,
    private readonly registry = SchemaRegistry.load()
  ) {
    this.executable = config.executable ?? discoverEngineExecutable("codex");
    this.baseArgs = config.baseArgs ?? [];
    this.adapterVersion = config.adapterVersion ?? "0.1.0";
    // timeoutMs remains for synchronous legacy callers. Async P5 execution uses the
    // watchdog below: legacy timeoutMs becomes an idle limit, never a hard 120 s cap.
    this.timeoutMs = config.timeoutMs ?? 20 * 60_000;
    this.idleTimeoutMs = config.idleTimeoutMs ?? config.timeoutMs ?? 3 * 60_000;
    this.maximumRuntimeMs = config.maximumRuntimeMs ?? 20 * 60_000;
    this.maximumRepeatedProgressEvents = config.maximumRepeatedProgressEvents ?? 4;
    // 1 MiB was too small for real exploratory tasks: codex exec --json echoes each
    // command's full output (including whole file contents from Read-equivalent
    // commands) back inside "aggregated_output" fields, and a task reading several
    // real source files can exceed 1 MiB before the model even finishes exploring -
    // confirmed live (spawnSync's maxBuffer growing the visible failure identically at
    // both a 20-minute and a 35-minute timeoutMs pointed at the same underlying cause).
    this.maximumOutputBytes = config.maximumOutputBytes ?? 20 * 1024 * 1024;
  }

  doctor(): CodexDoctorReport {
    const findings: CodexFinding[] = [];
    const versionOutput = spawnSync(this.executable, [...this.baseArgs, "--version"], {
      encoding: "utf8",
      timeout: 10_000,
      windowsHide: true,
      shell: needsShellWrapper(this.executable)
    });
    const version = versionOutput.status === 0 ? versionOutput.stdout.trim() || versionOutput.stderr.trim() : null;
    const parsedVersion = version ? parseCodexVersion(version) : null;

    if (!parsedVersion) {
      findings.push({
        severity: "blocker",
        code: "CODEX_VERSION_UNAVAILABLE",
        message: "Codex CLI version could not be read."
      });
    }

    const testedVersion = parsedVersion
      ? this.config.testedVersionRanges === undefined || versionMatchesAny(parsedVersion, this.config.testedVersionRanges)
      : false;
    if (parsedVersion && this.config.testedVersionRanges !== undefined && !testedVersion) {
      findings.push({
        severity: "blocker",
        code: "CODEX_VERSION_UNTESTED",
        message: `Codex CLI version ${parsedVersion} is not in the configured testedVersionRanges override.`
      });
    }

    const smokeTest = this.config.requiresCapabilitySmokeTest ? this.smokeTest(findings) : "SKIPPED";
    const behavioralSmokeTest = this.config.requiresCapabilitySmokeTest ? this.behavioralSmokeTest(findings) : "SKIPPED";

    return {
      status: findings.length > 0 ? "BLOCKED" : "PASS",
      executable: this.executable,
      version,
      parsedVersion,
      testedVersion,
      smokeTest,
      behavioralSmokeTest,
      findings
    };
  }

  buildExecInvocation(request: CodexStartRequest): CodexExecInvocation {
    // --output-schema/--output-last-message are deliberately NOT used: a live run
    // against a real ChatGPT-subscription Codex install (0.136.0-alpha.2) showed the
    // model reliably invokes the structured "final answer" tool --output-schema exposes
    // as its very first response, before doing any real work, then gets stuck unable to
    // continue ("Cannot execute shell commands after response-format tool misuse in
    // this turn") - reproduced 3 times, including with an explicit prompt instruction
    // against it. Removing the flag removes the tool the model was prematurely
    // reaching for. Structured output is instead read from the last `agent_message` in
    // the --json JSONL stream, with the same prose-tolerant extraction plus
    // client-side schema validation already used for the Claude adapter.
    // Codex CLI 0.147 maps `--ignore-user-config` to a managed read-only
    // permission profile that a later `--sandbox workspace-write` cannot widen.
    // Keep user config loading for authentication/managed permissions, then pin
    // every execution-critical value explicitly below. The worker runs in a
    // generated isolated Git worktree with no project instruction files.
    const args = [
      ...this.baseArgs,
      "exec",
      "--json",
      "--cd",
      request.worktreePath,
      "--sandbox",
      this.config.sandboxMode ?? "workspace-write",
      ...(this.config.defaultModel ? ["--model", this.config.defaultModel] : []),
      ...(this.config.reasoningEffort ? ["-c", `model_reasoning_effort="${this.config.reasoningEffort}"`] : []),
      "-"
    ];

    return {
      executable: this.executable,
      args,
      stdin: request.prompt
    };
  }

  start(request: CodexStartRequest): CodexExecution {
    const doctor = this.doctor();

    if (doctor.status === "BLOCKED") {
      const result = failedResult(request, doctor.findings[0]?.message ?? "Codex CLI is unavailable.");
      return {
        executionId: request.executionId,
        sessionId: request.sessionId,
        events: terminalEvents(request, "execution.failed", { reason: result.failures[0]?.message ?? "Codex failed." }, this.registry),
        usage: unknownUsage(),
        result
      };
    }

    const invocation = this.buildExecInvocation(request);
    const started = createEngineEvent({
      executionId: request.executionId,
      sequence: 0,
      startedAt: request.startedAt,
      type: "execution.started",
      payload: { engine: "codex", executable: this.executable },
      registry: this.registry
    });
    const session = createEngineEvent({
      executionId: request.executionId,
      sequence: 1,
      startedAt: request.startedAt,
      type: "session.bound",
      sessionId: request.sessionId,
      payload: { sessionId: request.sessionId },
      registry: this.registry
    });
    const child = spawnSync(invocation.executable, invocation.args, {
      cwd: request.worktreePath,
      input: invocation.stdin,
      encoding: "utf8",
      maxBuffer: this.maximumOutputBytes,
      timeout: this.timeoutMs,
      windowsHide: true,
      shell: needsShellWrapper(invocation.executable)
    });
    const result = readAgentResult(child, request, this.registry) ?? failedResult(request, childOutputMessage(child));
    const terminal = createEngineEvent({
      executionId: request.executionId,
      sequence: 2,
      startedAt: request.startedAt,
      type: child.status === 0 && result.status === "DONE" ? "execution.completed" : "execution.failed",
      sessionId: request.sessionId,
      payload: { status: result.status, exitCode: child.status },
      registry: this.registry
    });
    const events = [started, session, terminal];

    validateEngineEventStream(events);

    return {
      executionId: request.executionId,
      sessionId: request.sessionId,
      events,
      usage: parseCodexUsage(child.stdout),
      result
    };
  }

  async startAsync(request: CodexStartRequest): Promise<CodexExecution> {
    const doctor = this.doctor();

    if (doctor.status === "BLOCKED") {
      const result = failedResult(request, doctor.findings[0]?.message ?? "Codex CLI is unavailable.");
      return {
        executionId: request.executionId,
        sessionId: request.sessionId,
        events: terminalEvents(request, "execution.failed", { reason: result.failures[0]?.message ?? "Codex failed." }, this.registry),
        usage: unknownUsage(),
        result
      };
    }

    const invocation = this.buildExecInvocation(request);
    const started = createEngineEvent({
      executionId: request.executionId,
      sequence: 0,
      startedAt: request.startedAt,
      type: "execution.started",
      payload: { engine: "codex", executable: this.executable, async: true },
      registry: this.registry
    });
    const session = createEngineEvent({
      executionId: request.executionId,
      sequence: 1,
      startedAt: request.startedAt,
      type: "session.bound",
      sessionId: request.sessionId,
      payload: { sessionId: request.sessionId },
      registry: this.registry
    });
    const child = await spawnBuffered(invocation.executable, invocation.args, {
      cwd: request.worktreePath,
      input: invocation.stdin,
      maximumOutputBytes: this.maximumOutputBytes,
      timeoutMs: this.timeoutMs,
      watchdog: {
        idleTimeoutMs: this.idleTimeoutMs,
        maximumRuntimeMs: this.maximumRuntimeMs,
        maximumRepeatedProgressEvents: this.maximumRepeatedProgressEvents,
        progressDirectory: request.worktreePath,
        classifyProgressLine: classifyCodexProgressLine
      },
      shell: needsShellWrapper(invocation.executable)
    });
    const result = readAgentResult(child, request, this.registry) ?? failedResult(request, childOutputMessage(child));
    const terminal = createEngineEvent({
      executionId: request.executionId,
      sequence: 2,
      startedAt: request.startedAt,
      type: child.status === 0 && result.status === "DONE" ? "execution.completed" : "execution.failed",
      sessionId: request.sessionId,
      payload: { status: result.status, exitCode: child.status, timedOut: child.timedOut },
      registry: this.registry
    });
    const events = [started, session, terminal];

    validateEngineEventStream(events);

    return {
      executionId: request.executionId,
      sessionId: request.sessionId,
      events,
      usage: parseCodexUsage(child.stdout),
      result
    };
  }

  private smokeTest(findings: CodexFinding[]): "PASS" | "BLOCKED" {
    const smoke = spawnSync(this.executable, [...this.baseArgs, "exec", "--help"], {
      encoding: "utf8",
      timeout: 10_000,
      windowsHide: true,
      shell: needsShellWrapper(this.executable)
    });
    const combined = `${smoke.stdout}\n${smoke.stderr}`;
    const missing = REQUIRED_HELP_CAPABILITIES.filter((capability) => !combined.includes(capability));

    if (smoke.status !== 0 || missing.length > 0) {
      findings.push({
        severity: "blocker",
        code: "CODEX_SMOKE_TEST_FAILED",
        message:
          missing.length > 0
            ? `Codex CLI smoke test did not expose required exec capabilities: ${missing.join(", ")}.`
            : "Codex CLI smoke test did not exit successfully."
      });
      return "BLOCKED";
    }

    return "PASS";
  }

  private behavioralSmokeTest(findings: CodexFinding[]): "PASS" | "BLOCKED" {
    const invocation = this.buildExecInvocation({
      runId: "doctor-behavioral-smoke",
      taskId: "SMOKE",
      executionId: "doctor-behavioral-smoke-exec",
      sessionId: "doctor-behavioral-smoke-session",
      worktreePath: process.cwd(),
      prompt: "{}",
      startedAt: new Date(0).toISOString()
    });
    const forbidden = ["--output-schema", "--output-last-message"].filter((flag) => invocation.args.includes(flag));

    if (forbidden.length > 0) {
      findings.push({
        severity: "blocker",
        code: "CODEX_BEHAVIORAL_SMOKE_TEST_FAILED",
        message: `Codex behavioral smoke test found forbidden runtime flags: ${forbidden.join(", ")}.`
      });
      return "BLOCKED";
    }

    return "PASS";
  }
}

export function parseCodexVersion(output: string): string | null {
  const match = output.match(/(?:codex(?:-cli)?\s+)?([0-9]+\.[0-9]+\.[A-Za-z0-9._+-]+)/i);
  return match?.[1] ?? null;
}

interface CodexJsonlEvent {
  readonly type?: string;
  readonly item?: {
    readonly type?: string;
    readonly text?: string;
  };
}

function readAgentResult(
  child: ReturnType<typeof spawnSync> | BufferedProcessResult,
  request: CodexStartRequest,
  registry: SchemaRegistry
): AgentExecutionResult | null {
  if (child.status !== 0 || typeof child.stdout !== "string") {
    return null;
  }

  const lastAgentMessage = lastAgentMessageText(child.stdout);

  if (lastAgentMessage === null) {
    return null;
  }

  try {
    const candidate = parseAgentResultText(lastAgentMessage);
    registry.assertValid("agent-result.schema.json", candidate);
    return candidate as AgentExecutionResult;
  } catch {
    return null;
  }
}

export function lastAgentMessageText(stdout: string): string | null {
  let lastText: string | null = null;

  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();

    if (!trimmed) {
      continue;
    }

    let event: CodexJsonlEvent;
    try {
      event = JSON.parse(trimmed) as CodexJsonlEvent;
    } catch {
      continue;
    }

    if (event.type === "item.completed" && event.item?.type === "agent_message" && typeof event.item.text === "string") {
      lastText = event.item.text;
    }
  }

  return lastText;
}

export function parseAgentResultText(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");

    if (start === -1 || end === -1 || end <= start) {
      throw new Error("No JSON object found in Codex's final agent message.");
    }

    return JSON.parse(text.slice(start, end + 1));
  }
}

function failedResult(request: CodexStartRequest, message: string): AgentExecutionResult {
  return {
    schemaVersion: "1.0",
    runId: request.runId,
    taskId: request.taskId,
    status: "FAILED",
    summary: "Codex CLI execution failed.",
    touchedFiles: [],
    failures: [{ class: "engine", message }]
  };
}

function childOutputMessage(child: ReturnType<typeof spawnSync> | BufferedProcessResult): string {
  // Provider output is private evidence. It can contain source paths, prompt
  // fragments, tool arguments, or a secret echoed by a failed command. Never
  // propagate it through the public worker/root/benchmark finding chain.
  if ("stopReason" in child && child.stopReason === "idle-timeout") return "Codex CLI made no observable progress before the idle watchdog expired.";
  if ("stopReason" in child && child.stopReason === "loop-detected") return "Codex CLI repeated the same semantic action until the loop guard stopped it.";
  if ("stopReason" in child && child.stopReason === "hard-timeout") return "Codex CLI exceeded the configured safety circuit breaker before producing a valid agent result.";
  if (childTimedOut(child)) return "Codex CLI timed out before producing a valid agent result.";
  if ("outputTruncated" in child && child.outputTruncated) return "Codex CLI output exceeded the configured maximum before producing a valid agent result.";
  if (child.error) return "Codex CLI process failed before producing a valid agent result.";
  if (child.status !== 0) return "Codex CLI exited unsuccessfully before producing a valid agent result.";
  return "Codex did not produce a valid agent result.";
}

/**
 * Produces only a tiny, non-sensitive action identity. Raw provider output is never
 * persisted in the watchdog or public findings. Token counters do not count as
 * progress; a repeated command/tool action does.
 */
export function classifyCodexProgressLine(stream: "stdout" | "stderr", line: string): string | null {
  if (stream !== "stdout") return null;
  try {
    const event = JSON.parse(line) as {
      readonly type?: unknown;
      readonly item?: { readonly type?: unknown; readonly command?: unknown; readonly path?: unknown };
    };
    const type = typeof event.type === "string" ? event.type : null;
    const itemType = typeof event.item?.type === "string" ? event.item.type : null;
    if (!type) return null;
    // Codex emits an item.started and an item.completed for one command. Only
    // completed commands are semantic loop events; otherwise ordinary lifecycle
    // pairs can be counted twice and stop a healthy run.
    if (itemType === "command_execution" && type === "item.completed") {
      const command = typeof event.item?.command === "string" ? event.item.command.replace(/\s+/g, " ") : "unknown";
      // Command text may contain a path, argument or a secret-like value. The
      // watchdog needs equality only, so retain a short hash rather than the text.
      return `command:${createHash("sha256").update(command).digest("hex").slice(0, 16)}`;
    }
    if (itemType === "file_change") return `file-change:${type}`;
    if (type === "thread.started" || type === "turn.started" || type === "turn.completed") return type;
    return null;
  } catch {
    return null;
  }
}

function childTimedOut(child: ReturnType<typeof spawnSync> | BufferedProcessResult): boolean {
  const error = child.error as (Error & { readonly code?: string }) | undefined;
  return ("timedOut" in child && child.timedOut === true) || error?.code === "ETIMEDOUT";
}

function terminalEvents(
  request: CodexStartRequest,
  type: "execution.completed" | "execution.failed",
  payload: Record<string, unknown>,
  registry: SchemaRegistry
): readonly EngineEvent[] {
  const events = [
    createEngineEvent({
      executionId: request.executionId,
      sequence: 0,
      startedAt: request.startedAt,
      type: "execution.started",
      payload: { engine: "codex" },
      registry
    }),
    createEngineEvent({
      executionId: request.executionId,
      sequence: 1,
      startedAt: request.startedAt,
      type,
      sessionId: request.sessionId,
      payload,
      registry
    })
  ];

  validateEngineEventStream(events);
  return events;
}

function unknownUsage(): EngineUsage {
  return {
    inputUncachedTokens: null,
    cacheReadTokens: null,
    cacheWriteTokens: null,
    outputTokens: null,
    costUsd: null
  };
}

interface CodexTokenCountEvent {
  readonly type?: string;
  readonly payload?: {
    readonly type?: string;
    readonly info?: {
      readonly total_token_usage?: {
        readonly input_tokens?: unknown;
        readonly cached_input_tokens?: unknown;
        readonly cache_write_input_tokens?: unknown;
        readonly output_tokens?: unknown;
      };
    };
  };
}

// codex exec --json emits event_msg/token_count lines with a "total_token_usage" that is
// already cumulative for the whole invocation (confirmed against a live rollout, see
// docs/HANDOFF-BENCHMARK-TOOL-AND-PHASE-4.md) - the LAST such event is the final total,
// no summing across events needed. cached_input_tokens is a subset of input_tokens (same
// convention as OpenAI's Responses API usage object, not an additional amount), so it is
// subtracted out to get the uncached count. cache_write_input_tokens was confirmed present
// in a real CLI 0.147.0 rollout on 2026-09-02 (P2-B live run) - an earlier sanitized
// fixture captured before that date did not have the field, which is why this was
// previously treated as never-surfaced; that was a stale assumption, not a current CLI
// limitation, so it is now read like any other real field. A dollar cost is still not
// surfaced anywhere in the stream for a ChatGPT-subscription-authenticated account
// (confirmed live: the same rollout's `rate_limits.credits` reports `has_credits: false`,
// `balance: "0"` - there is no dollar ledger to report from in this billing mode, only a
// rate-limit percentage, a different unit than EngineUsage) - costUsd stays null rather
// than guessed.
export const CODEX_USAGE_PARSER_VERSION = "codex-token-count.v1";

export function parseCodexUsage(stdout: unknown): EngineUsage {
  if (typeof stdout !== "string") {
    return unknownUsage();
  }

  let lastTotal: { input_tokens?: unknown; cached_input_tokens?: unknown; cache_write_input_tokens?: unknown; output_tokens?: unknown } | null = null;

  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();

    if (!trimmed) {
      continue;
    }

    let event: CodexTokenCountEvent;
    try {
      event = JSON.parse(trimmed) as CodexTokenCountEvent;
    } catch {
      continue;
    }

    if (event.type === "event_msg" && event.payload?.type === "token_count" && event.payload.info?.total_token_usage) {
      lastTotal = event.payload.info.total_token_usage;
    }
  }

  if (!lastTotal) {
    return unknownUsage();
  }

  const inputTokens = readNumber(lastTotal.input_tokens);
  const cachedTokens = readNumber(lastTotal.cached_input_tokens);

  return {
    inputUncachedTokens: inputTokens === null ? null : Math.max(0, inputTokens - (cachedTokens ?? 0)),
    cacheReadTokens: cachedTokens,
    cacheWriteTokens: readNumber(lastTotal.cache_write_input_tokens),
    outputTokens: readNumber(lastTotal.output_tokens),
    costUsd: null
  };
}

function readNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

export function writeFakeCodexCli(
  path: string,
  options: {
    readonly version: string;
    readonly supportsExecHelp?: boolean;
    readonly touchedFile?: string;
    readonly delayMs?: number;
    readonly capturePromptPath?: string;
    /** Wraps the JSON result in prose, simulating a model that does not follow the
     *  "respond with ONLY the JSON object" instruction exactly. */
    readonly wrapResultInProse?: boolean;
    /** Overrides the fake CLI's cumulative total_token_usage, matching the real
     *  event_msg/token_count shape. Defaults to a realistic non-zero sample so
     *  usage-parsing tests exercise real field extraction. Pass null to omit the
     *  token_count event entirely (simulates an older CLI that doesn't emit it). */
    readonly usage?: {
      readonly inputTokens?: number;
      readonly cachedInputTokens?: number;
      /** Omitted by default (not merely 0) so existing tests that assert `cacheWriteTokens:
       *  null` keep documenting the "field absent from this CLI/response" case; pass 0 or a
       *  positive number to exercise the "field present" case added 2026-09-02. */
      readonly cacheWriteInputTokens?: number;
      readonly outputTokens?: number;
    } | null;
  }
): void {
  const supportsExecHelp = options.supportsExecHelp ?? true;
  const usage =
    options.usage === null
      ? null
      : {
          input_tokens: options.usage?.inputTokens ?? 5300,
          cached_input_tokens: options.usage?.cachedInputTokens ?? 4200,
          ...(options.usage?.cacheWriteInputTokens !== undefined
            ? { cache_write_input_tokens: options.usage.cacheWriteInputTokens }
            : {}),
          output_tokens: options.usage?.outputTokens ?? 340,
          total_tokens: (options.usage?.inputTokens ?? 5300) + (options.usage?.outputTokens ?? 340)
        };
  const source = `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args.includes("--version")) {
  console.log("codex-cli ${options.version}");
  process.exit(0);
}
if (${JSON.stringify(supportsExecHelp)} && args[0] === "exec" && args.includes("--help")) {
  console.log("--json\\n--cd\\n--sandbox");
  process.exit(0);
}
  if (args[0] === "exec") {
  const fs = await import("node:fs");
  const path = await import("node:path");
  let request = {};
  try {
    request = JSON.parse(fs.readFileSync(0, "utf8"));
  } catch {}
  const touchedFile = ${JSON.stringify(options.touchedFile ?? null)};
  const capturePromptPath = ${JSON.stringify(options.capturePromptPath ?? null)};
  if (capturePromptPath) {
    fs.mkdirSync(path.dirname(capturePromptPath), { recursive: true });
    fs.writeFileSync(capturePromptPath, JSON.stringify(request, null, 2));
  }
  const delayMs = ${JSON.stringify(options.delayMs ?? 0)};
  if (delayMs > 0) {
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  if (touchedFile) {
    fs.mkdirSync(path.dirname(touchedFile), { recursive: true });
    fs.writeFileSync(touchedFile, "codex fake output\\n");
  }
  const result = {
    schemaVersion: "1.0",
    runId: request.runId ?? "run-codex",
    taskId: request.taskId ?? "TASK-01",
    status: "DONE",
    summary: "fake codex done",
    touchedFiles: touchedFile ? [touchedFile] : [],
    failures: []
  };
  const resultText = ${JSON.stringify(options.wrapResultInProse ?? false)}
    ? "Everything looks correct, here is the final result:\\n" + JSON.stringify(result)
    : JSON.stringify(result);
  console.log(JSON.stringify({ type: "thread.started", thread_id: "fake-thread" }));
  console.log(JSON.stringify({ type: "turn.started" }));
  const usage = ${JSON.stringify(usage)};
  if (usage) {
    console.log(JSON.stringify({
      type: "event_msg",
      payload: { type: "token_count", info: { total_token_usage: usage }, rate_limits: { primary: { used_percent: 0 } } }
    }));
  }
  console.log(JSON.stringify({
    type: "item.completed",
    item: { id: "item_0", type: "agent_message", text: resultText }
  }));
  process.exit(0);
}
process.exit(2);
`;
  writeFileSync(path, source, "utf8");
}
