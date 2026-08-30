import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import type { AgentExecutionResult } from "./fake-engine.js";
import { createEngineEvent, validateEngineEventStream, type EngineEvent, type EngineUsage } from "./engine-event.js";
import { spawnBuffered, type BufferedProcessResult } from "./spawn-buffered.js";
import { needsShellWrapper } from "./spawn-shell.js";
import { versionMatchesAny } from "./version-match.js";
import { SchemaRegistry } from "../schema/json-schema.js";
import { discoverEngineExecutable } from "./discover-cli.js";

const DEFAULT_ALLOWED_TOOLS: readonly string[] = ["Read", "Edit", "Write", "Grep", "Glob"];

// `--json-schema` is deliberately NOT required or used here: it is advertised in
// `claude -p --help` but hangs indefinitely at runtime on the verified local install
// (2.1.177), regardless of auth state, prompt delivery, or --output-format. Structured
// output is instead enforced by prompt instruction plus client-side schema validation
// in readAgentResult() below - the same fail-closed guarantee without relying on a
// CLI flag that is documented but non-functional.
//
// `--bare` is NOT in this required list because it is opt-in (see bareMode below), not
// used by default: `--bare` explicitly skips OAuth/keychain auth (per its own --help
// text) and requires ANTHROPIC_API_KEY, which is the wrong default for a worker meant
// to run under the same Claude subscription session a developer already has open.
export const REQUIRED_HELP_CAPABILITIES: readonly string[] = [
  "--output-format",
  "stream-json",
  "--tools",
  "--allowedTools",
  "--permission-mode",
  "--session-id",
  "--no-session-persistence",
  "--input-format"
];

export interface ClaudeCliAdapterConfig {
  readonly executable?: string;
  readonly baseArgs?: readonly string[];
  /** Optional compatibility override. When absent, behavioral smoke tests are the gate. */
  readonly testedVersionRanges?: readonly string[];
  readonly requiresCapabilitySmokeTest: boolean;
  readonly permissionMode?: "default" | "auto" | "plan" | "acceptEdits" | "bypassPermissions" | "dontAsk";
  readonly allowedTools?: readonly string[];
  readonly adapterVersion?: string;
  readonly defaultModel?: string | null;
  readonly timeoutMs?: number;
  readonly maximumOutputBytes?: number;
  /**
   * Opt-in `--bare` mode: skips OAuth/keychain auth and requires ANTHROPIC_API_KEY.
   * Default false, so headless runs authenticate the same way an interactive `claude`
   * session on this machine does (subscription login, not API billing). Set true only
   * for an unattended environment that is deliberately provisioned with an API key
   * instead of a logged-in session.
   */
  readonly bareMode?: boolean;
  /** Explicit opt-in for a CLI session that is already externally sandboxed. */
  readonly dangerouslySkipPermissions?: boolean;
}

export interface ClaudeDoctorReport {
  readonly status: "PASS" | "BLOCKED";
  readonly executable: string;
  readonly version: string | null;
  readonly parsedVersion: string | null;
  readonly testedVersion: boolean;
  readonly smokeTest: "PASS" | "BLOCKED" | "SKIPPED";
  readonly behavioralSmokeTest: "PASS" | "BLOCKED" | "SKIPPED";
  readonly findings: readonly ClaudeFinding[];
}

export interface ClaudeFinding {
  readonly severity: "blocker";
  readonly code: "CLAUDE_VERSION_UNAVAILABLE" | "CLAUDE_VERSION_UNTESTED" | "CLAUDE_SMOKE_TEST_FAILED" | "CLAUDE_BEHAVIORAL_SMOKE_TEST_FAILED";
  readonly message: string;
}

export interface ClaudeStartRequest {
  readonly runId: string;
  readonly taskId: string;
  readonly executionId: string;
  readonly sessionId: string;
  readonly worktreePath: string;
  readonly prompt: string;
  readonly startedAt: string;
}

export interface ClaudeExecution {
  readonly executionId: string;
  readonly sessionId: string;
  readonly events: readonly EngineEvent[];
  readonly usage: EngineUsage;
  readonly result: AgentExecutionResult;
}

export interface ClaudeExecInvocation {
  readonly executable: string;
  readonly args: readonly string[];
  readonly stdin: string;
}

export class ClaudeCliAdapter {
  private readonly executable: string;
  private readonly baseArgs: readonly string[];
  private readonly permissionMode: "default" | "auto" | "plan" | "acceptEdits" | "bypassPermissions" | "dontAsk";
  private readonly allowedTools: readonly string[];
  private readonly adapterVersion: string;
  private readonly timeoutMs: number;
  private readonly maximumOutputBytes: number;

  constructor(
    private readonly config: ClaudeCliAdapterConfig,
    private readonly registry = SchemaRegistry.load()
  ) {
    this.executable = config.executable ?? discoverEngineExecutable("claude");
    this.baseArgs = config.baseArgs ?? [];
    this.permissionMode = config.permissionMode ?? "dontAsk";
    this.allowedTools = config.allowedTools ?? DEFAULT_ALLOWED_TOOLS;
    this.adapterVersion = config.adapterVersion ?? "0.1.0";
    this.timeoutMs = config.timeoutMs ?? 60_000;
    this.maximumOutputBytes = config.maximumOutputBytes ?? 1024 * 1024;
  }

  doctor(): ClaudeDoctorReport {
    const findings: ClaudeFinding[] = [];
    const versionOutput = spawnSync(this.executable, [...this.baseArgs, "--version"], {
      encoding: "utf8",
      timeout: 10_000,
      windowsHide: true,
      shell: needsShellWrapper(this.executable)
    });
    const version = versionOutput.status === 0 ? versionOutput.stdout.trim() || versionOutput.stderr.trim() : null;
    const parsedVersion = version ? parseClaudeVersion(version) : null;

    if (!parsedVersion) {
      findings.push({
        severity: "blocker",
        code: "CLAUDE_VERSION_UNAVAILABLE",
        message: "Claude Code CLI version could not be read."
      });
    }

    const testedVersion = parsedVersion
      ? this.config.testedVersionRanges === undefined || versionMatchesAny(parsedVersion, this.config.testedVersionRanges)
      : false;
    if (parsedVersion && this.config.testedVersionRanges !== undefined && !testedVersion) {
      findings.push({
        severity: "blocker",
        code: "CLAUDE_VERSION_UNTESTED",
        message: `Claude Code CLI version ${parsedVersion} is not in the configured testedVersionRanges override.`
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

  buildExecInvocation(request: ClaudeStartRequest): ClaudeExecInvocation {
    const args = [
      ...this.baseArgs,
      "-p",
      ...(this.config.bareMode ? ["--bare"] : []),
      ...(this.config.dangerouslySkipPermissions ? ["--dangerously-skip-permissions"] : []),
      "--no-session-persistence",
      "--input-format",
      "text",
      "--output-format",
      "json",
      // Claude CLI's --session-id requires a valid UUID; the worker's own sessionId
      // (used for EngineEvent/AgentExecutionResult tracking) is a human-readable
      // string, not a UUID, so a fresh UUID is generated here instead. Nothing relies
      // on this matching the worker's sessionId - --no-session-persistence means
      // Claude does not persist anything under it, it is purely a per-invocation
      // handle for this one subprocess call.
      "--session-id",
      randomUUID(),
      // `--tools` makes a tool available at all; under --permission-mode dontAsk that
      // is NOT the same as being permitted to use it - dontAsk denies anything not
      // also explicitly granted via --allowedTools. Confirmed against a live run: with
      // --tools alone, Edit/Write were auto-denied ("Edit and Write tools are both
      // auto-denied by 'don't ask mode' permission settings"), even though Claude's
      // own plan for the task was correct. Both flags carry the same allowlist here.
      "--tools",
      this.allowedTools.join(","),
      "--allowedTools",
      this.allowedTools.join(","),
      "--permission-mode",
      this.permissionMode,
      "--add-dir",
      request.worktreePath
    ];

    if (this.config.defaultModel) {
      args.push("--model", this.config.defaultModel);
    }

    // Prompt is delivered via stdin (no positional prompt argument) so it never hits an
    // argv length limit, mirroring Codex's stdin approach - confirmed working against a
    // live `claude -p` invocation, both with and without --bare. Without --bare (the
    // default), headless auth resolves the same way an interactive session does
    // (OAuth/keychain from `claude login`), confirmed against a live subscription
    // session - no ANTHROPIC_API_KEY needed. Hooks/CLAUDE.md/plugin-sync from the
    // target repo and the user's own ~/.claude/settings.json also apply in that mode,
    // same as an interactive session in that worktree would see.
    return {
      executable: this.executable,
      args,
      stdin: request.prompt
    };
  }

  start(request: ClaudeStartRequest): ClaudeExecution {
    const doctor = this.doctor();

    if (doctor.status === "BLOCKED") {
      const result = failedResult(request, doctor.findings[0]?.message ?? "Claude Code CLI is unavailable.");
      return {
        executionId: request.executionId,
        sessionId: request.sessionId,
        events: terminalEvents(request, "execution.failed", { reason: result.failures[0]?.message ?? "Claude failed." }, this.registry),
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
      payload: { engine: "claude", executable: this.executable },
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
      usage: parseClaudeUsage(child.stdout),
      result
    };
  }

  async startAsync(request: ClaudeStartRequest): Promise<ClaudeExecution> {
    const doctor = this.doctor();

    if (doctor.status === "BLOCKED") {
      const result = failedResult(request, doctor.findings[0]?.message ?? "Claude Code CLI is unavailable.");
      return {
        executionId: request.executionId,
        sessionId: request.sessionId,
        events: terminalEvents(request, "execution.failed", { reason: result.failures[0]?.message ?? "Claude failed." }, this.registry),
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
      payload: { engine: "claude", executable: this.executable, async: true },
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
      usage: parseClaudeUsage(child.stdout),
      result
    };
  }

  private smokeTest(findings: ClaudeFinding[]): "PASS" | "BLOCKED" {
    const smoke = spawnSync(this.executable, [...this.baseArgs, "-p", "--help"], {
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
        code: "CLAUDE_SMOKE_TEST_FAILED",
        message:
          missing.length > 0
            ? `Claude Code CLI smoke test did not expose required capabilities: ${missing.join(", ")}.`
            : "Claude Code CLI smoke test did not exit successfully."
      });
      return "BLOCKED";
    }

    return "PASS";
  }

  private behavioralSmokeTest(findings: ClaudeFinding[]): "PASS" | "BLOCKED" {
    const invocation = this.buildExecInvocation({
      runId: "doctor-behavioral-smoke",
      taskId: "SMOKE",
      executionId: "doctor-behavioral-smoke-exec",
      sessionId: "doctor-behavioral-smoke-session",
      worktreePath: process.cwd(),
      prompt: "{}",
      startedAt: new Date(0).toISOString()
    });
    const forbidden = ["--json-schema", "--dangerously-skip-permissions", "--allow-dangerously-skip-permissions"].filter((flag) => {
      if (flag === "--dangerously-skip-permissions" && this.config.dangerouslySkipPermissions === true) return false;
      return invocation.args.includes(flag);
    });

    if (forbidden.length > 0) {
      findings.push({
        severity: "blocker",
        code: "CLAUDE_BEHAVIORAL_SMOKE_TEST_FAILED",
        message: `Claude behavioral smoke test found forbidden runtime flags: ${forbidden.join(", ")}.`
      });
      return "BLOCKED";
    }

    return "PASS";
  }
}

export function parseClaudeVersion(output: string): string | null {
  const match = output.match(/([0-9]+\.[0-9]+\.[A-Za-z0-9._+-]+)/);
  return match?.[1] ?? null;
}

function readAgentResult(
  child: ReturnType<typeof spawnSync> | BufferedProcessResult,
  request: ClaudeStartRequest,
  registry: SchemaRegistry
): AgentExecutionResult | null {
  if (child.status !== 0 || typeof child.stdout !== "string") {
    return null;
  }

  try {
    const envelope = JSON.parse(child.stdout) as { readonly result?: unknown };

    if (typeof envelope.result !== "string") {
      registry.assertValid("agent-result.schema.json", envelope.result);
      return envelope.result as AgentExecutionResult;
    }

    // The prompt instructs the model to respond with ONLY the JSON object, but models
    // sometimes still wrap it in prose (confirmed on live runs: both a short "The file
    // looks correct... {json}" wrapper, and a longer markdown summary whose own code
    // spans - e.g. "{ promoCode }" - contain stray braces that broke a naive
    // first-{-to-last-} extraction). Scan every top-level balanced {...} span in the
    // text (ignoring braces inside string literals) and try them last-to-first, since
    // the real envelope is instructed to be the final thing in the response - each
    // candidate is still schema-validated, so a wrong extraction is skipped rather than
    // silently accepted.
    for (const candidate of candidateAgentResultObjects(envelope.result)) {
      try {
        registry.assertValid("agent-result.schema.json", candidate);
        return candidate as AgentExecutionResult;
      } catch {
        continue;
      }
    }

    return null;
  } catch {
    return null;
  }
}

export function candidateAgentResultObjects(text: string): readonly unknown[] {
  const direct = tryParseJson(text);

  if (direct !== undefined) {
    return [direct];
  }

  const spans = topLevelBraceSpans(text);
  const candidates: unknown[] = [];

  for (let index = spans.length - 1; index >= 0; index -= 1) {
    const span = spans[index]!;
    const parsed = tryParseJson(text.slice(span.start, span.end));

    if (parsed !== undefined) {
      candidates.push(parsed);
    }
  }

  return candidates;
}

function tryParseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function topLevelBraceSpans(text: string): readonly { readonly start: number; readonly end: number }[] {
  const spans: { start: number; end: number }[] = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]!;

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === "\"") {
        inString = false;
      }
      continue;
    }

    if (char === "\"") {
      inString = true;
    } else if (char === "{") {
      if (depth === 0) {
        start = index;
      }
      depth += 1;
    } else if (char === "}") {
      if (depth > 0) {
        depth -= 1;
        if (depth === 0 && start !== -1) {
          spans.push({ start, end: index + 1 });
          start = -1;
        }
      }
    }
  }

  return spans;
}

function failedResult(request: ClaudeStartRequest, message: string): AgentExecutionResult {
  return {
    schemaVersion: "1.0",
    runId: request.runId,
    taskId: request.taskId,
    status: "FAILED",
    summary: "Claude Code CLI execution failed.",
    touchedFiles: [],
    failures: [{ class: "engine", message }]
  };
}

function childOutputMessage(child: ReturnType<typeof spawnSync> | BufferedProcessResult): string {
  const output = [
    typeof child.stdout === "string" ? child.stdout : "",
    typeof child.stderr === "string" ? child.stderr : "",
    child.error?.message ?? ""
  ]
    .filter((part) => part.length > 0)
    .join("\n")
    .trim();

  return output.length > 0 ? output.slice(0, 4000) : "Claude did not produce a valid agent result.";
}

function terminalEvents(
  request: ClaudeStartRequest,
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
      payload: { engine: "claude" },
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

interface ClaudeUsagePayload {
  readonly input_tokens?: unknown;
  readonly cache_creation_input_tokens?: unknown;
  readonly cache_read_input_tokens?: unknown;
  readonly output_tokens?: unknown;
}

interface ClaudeResultEnvelope {
  readonly usage?: ClaudeUsagePayload;
  readonly total_cost_usd?: unknown;
}

// `claude -p --output-format json` returns a top-level envelope with a "usage" object
// alongside "result"/"session_id"/"total_cost_usd" - confirmed against a live invocation
// (2.1.177). Per Anthropic's Messages API, usage.input_tokens already excludes cached
// tokens (cache_creation/cache_read are reported separately), so it maps directly to
// inputUncachedTokens with no arithmetic needed.
export const CLAUDE_USAGE_PARSER_VERSION = "claude-result.v1";

export function parseClaudeUsage(stdout: unknown): EngineUsage {
  if (typeof stdout !== "string") {
    return unknownUsage();
  }

  try {
    const envelope = JSON.parse(stdout) as ClaudeResultEnvelope;
    const usage = envelope.usage;

    if (!usage || typeof usage !== "object") {
      return unknownUsage();
    }

    return {
      inputUncachedTokens: readNumber(usage.input_tokens),
      cacheReadTokens: readNumber(usage.cache_read_input_tokens),
      cacheWriteTokens: readNumber(usage.cache_creation_input_tokens),
      outputTokens: readNumber(usage.output_tokens),
      costUsd: readNumber(envelope.total_cost_usd)
    };
  } catch {
    return unknownUsage();
  }
}

function readNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

export function writeFakeClaudeCli(
  path: string,
  options: {
    readonly version: string;
    readonly supportsPrintHelp?: boolean;
    readonly touchedFile?: string;
    readonly delayMs?: number;
    readonly capturePromptPath?: string;
    /** Wraps the JSON result in prose, simulating a model that does not follow the
     *  "respond with ONLY the JSON object" instruction exactly. */
    readonly wrapResultInProse?: boolean;
    /** Wraps the JSON result in prose that itself contains stray, non-JSON braces
     *  (e.g. a markdown code span like "{ promoCode }"), simulating the failure mode
     *  found on a live consumer-project run where a naive first-{-to-last-} scan grabbed the
     *  wrong span. */
    readonly wrapResultWithStrayBraces?: boolean;
    /** Overrides the fake CLI's "usage" object (input_tokens/cache_creation_input_tokens/
     *  cache_read_input_tokens/output_tokens) and top-level total_cost_usd, matching the
     *  real `--output-format json` envelope shape. Defaults to a realistic non-zero
     *  sample so usage-parsing tests exercise real field extraction. */
    readonly usage?: {
      readonly inputTokens?: number;
      readonly cacheCreationInputTokens?: number;
      readonly cacheReadInputTokens?: number;
      readonly outputTokens?: number;
      readonly totalCostUsd?: number;
    };
  }
): void {
  const supportsPrintHelp = options.supportsPrintHelp ?? true;
  const usage = {
    input_tokens: options.usage?.inputTokens ?? 120,
    cache_creation_input_tokens: options.usage?.cacheCreationInputTokens ?? 30,
    cache_read_input_tokens: options.usage?.cacheReadInputTokens ?? 4500,
    output_tokens: options.usage?.outputTokens ?? 200
  };
  const totalCostUsd = options.usage?.totalCostUsd ?? 0.0123;
  const source = `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args.includes("--version")) {
  console.log("${options.version} (Claude Code)");
  process.exit(0);
}
if (${JSON.stringify(supportsPrintHelp)} && args[0] === "-p" && args.includes("--help")) {
  console.log([
    "--output-format <format> \\"text\\", \\"json\\" (single result), or \\"stream-json\\" (realtime streaming)",
    "--json-schema <schema>",
    "--tools <tools...>",
    "--allowedTools <tools...>",
    "--permission-mode <mode>",
    "--bare",
    "--session-id <uuid>",
    "--no-session-persistence",
    "--input-format <format>"
  ].join("\\n"));
  process.exit(0);
}
if (args[0] === "-p") {
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
    fs.writeFileSync(touchedFile, "claude fake output\\n");
  }
  const sessionIndex = args.indexOf("--session-id");
  const sessionId = sessionIndex >= 0 ? args[sessionIndex + 1] : "fake-session";
  const result = {
    schemaVersion: "1.0",
    runId: request.runId ?? "run-claude",
    taskId: request.taskId ?? "TASK-01",
    status: "DONE",
    summary: "fake claude done",
    touchedFiles: touchedFile ? [touchedFile] : [],
    failures: []
  };
  const resultText = ${JSON.stringify(options.wrapResultWithStrayBraces ?? false)}
    ? "The endpoint accepts a JSON body shaped like { promoCode } and returns a typed error.\\n\\n" + JSON.stringify(result)
    : ${JSON.stringify(options.wrapResultInProse ?? false)}
    ? "Everything looks correct, here is the final result:\\n" + JSON.stringify(result)
    : JSON.stringify(result);
  console.log(JSON.stringify({
    result: resultText,
    session_id: sessionId,
    total_cost_usd: ${JSON.stringify(totalCostUsd)},
    usage: ${JSON.stringify(usage)}
  }));
  process.exit(0);
}
process.exit(2);
`;
  writeFileSync(path, source, "utf8");
}
