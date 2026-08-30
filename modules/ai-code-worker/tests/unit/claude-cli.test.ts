import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import {
  CLAUDE_USAGE_PARSER_VERSION,
  ClaudeCliAdapter,
  parseClaudeUsage,
  parseClaudeVersion,
  writeFakeClaudeCli
} from "../../src/engines/claude-cli.js";
import { versionMatches } from "../../src/engines/version-match.js";

const tempRoots: string[] = [];

after(() => {
  for (const root of tempRoots) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("claude cli adapter", () => {
  it("parses the sanitized result envelope with a versioned parser", () => {
    const usage = parseClaudeUsage(readFileSync("tests/fixtures/engine-usage/claude-output-format-json.sample.json", "utf8"));

    assert.equal(CLAUDE_USAGE_PARSER_VERSION, "claude-result.v1");
    assert.deepEqual(usage, {
      inputUncachedTokens: 4,
      cacheReadTokens: 15420,
      cacheWriteTokens: 1823,
      outputTokens: 612,
      costUsd: 0.0842
    });
  });

  it("accepts a newly discovered version when no static range override is configured", () => {
    const cli = fakeCli("9.9.9");
    const adapter = new ClaudeCliAdapter({
      executable: process.execPath,
      baseArgs: [cli],
      requiresCapabilitySmokeTest: true
    });

    assert.equal(adapter.doctor().status, "PASS");
  });

  it("parses Claude Code CLI version output and tested version ranges", () => {
    assert.equal(parseClaudeVersion("2.1.177 (Claude Code)"), "2.1.177");
    assert.equal(versionMatches("2.1.177", "2.1.x"), true);
    assert.equal(versionMatches("2.2.0", "2.1.x"), false);
  });

  it("passes doctor only for tested versions with required print capabilities", () => {
    const cli = fakeCli("2.1.177");
    const adapter = new ClaudeCliAdapter({
      executable: process.execPath,
      baseArgs: [cli],
      testedVersionRanges: ["2.1.x"],
      requiresCapabilitySmokeTest: true
    });
    const report = adapter.doctor();

    assert.equal(report.status, "PASS");
    assert.equal(report.parsedVersion, "2.1.177");
    assert.equal(report.smokeTest, "PASS");
    assert.equal(report.behavioralSmokeTest, "PASS");
  });

  it("fails closed for untested versions", () => {
    const cli = fakeCli("9.9.9");
    const adapter = new ClaudeCliAdapter({
      executable: process.execPath,
      baseArgs: [cli],
      testedVersionRanges: ["2.1.x"],
      requiresCapabilitySmokeTest: true
    });
    const report = adapter.doctor();

    assert.equal(report.status, "BLOCKED");
    assert.equal(report.findings[0]?.code, "CLAUDE_VERSION_UNTESTED");
  });

  it("fails closed when the binary is missing", () => {
    const adapter = new ClaudeCliAdapter({
      executable: join(tmpdir(), "no-such-claude-binary-xyz"),
      testedVersionRanges: ["2.1.x"],
      requiresCapabilitySmokeTest: true
    });
    const report = adapter.doctor();

    assert.equal(report.status, "BLOCKED");
    assert.equal(report.findings[0]?.code, "CLAUDE_VERSION_UNAVAILABLE");
  });

  it("fails closed when the smoke test does not expose required capabilities", () => {
    const cli = fakeCli("2.1.177", { supportsPrintHelp: false });
    const adapter = new ClaudeCliAdapter({
      executable: process.execPath,
      baseArgs: [cli],
      testedVersionRanges: ["2.1.x"],
      requiresCapabilitySmokeTest: true
    });
    const report = adapter.doctor();

    assert.equal(report.status, "BLOCKED");
    assert.equal(report.findings.at(-1)?.code, "CLAUDE_SMOKE_TEST_FAILED");
  });

  it("builds non-interactive invocations without granting Bash and without accepting secrets on argv", () => {
    const cli = fakeCli("2.1.177");
    const adapter = new ClaudeCliAdapter({
      executable: process.execPath,
      baseArgs: [cli],
      testedVersionRanges: ["2.1.x"],
      requiresCapabilitySmokeTest: false,
      defaultModel: "sonnet"
    });
    const invocation = adapter.buildExecInvocation({
      runId: "run-claude",
      taskId: "TASK-01",
      executionId: "exec-1",
      sessionId: "session-1",
      worktreePath: "C:/repo/worktree",
      prompt: "Implement task.",
      startedAt: "2026-08-01T10:00:00Z"
    });

    assert.ok(invocation.args.includes("-p"));
    // --bare is opt-in (bareMode), not the default: default headless auth must resolve
    // via OAuth/keychain the same way an interactive `claude` session does, not require
    // ANTHROPIC_API_KEY.
    assert.ok(!invocation.args.includes("--bare"));
    assert.ok(invocation.args.includes("--no-session-persistence"));
    assert.ok(invocation.args.includes("--output-format"));
    assert.ok(invocation.args.includes("json"));
    assert.ok(invocation.args.includes("--tools"));
    assert.ok(invocation.args.includes("--permission-mode"));
    assert.ok(invocation.args.includes("dontAsk"));
    assert.ok(invocation.args.includes("--session-id"));
    const sessionIdIndex = invocation.args.indexOf("--session-id");
    // --session-id must be a valid UUID for the real Claude CLI, regardless of the
    // worker's own (non-UUID) sessionId string.
    assert.match(invocation.args[sessionIdIndex + 1]!, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
    assert.ok(invocation.args.includes("--model"));
    assert.ok(invocation.args.includes("sonnet"));
    assert.equal(invocation.stdin, "Implement task.");
    assert.ok(!invocation.args.includes("Bash"));
    assert.ok(!invocation.args.includes("--dangerously-skip-permissions"));
    assert.ok(!invocation.args.includes("--allow-dangerously-skip-permissions"));
    // --json-schema is advertised in --help but hangs indefinitely at runtime on the
    // verified local install (confirmed via live smoke test) - must never be emitted.
    assert.ok(!invocation.args.includes("--json-schema"));

    const toolsIndex = invocation.args.indexOf("--tools");
    assert.equal(invocation.args[toolsIndex + 1], "Read,Edit,Write,Grep,Glob");

    // --tools alone makes a tool available; under --permission-mode dontAsk that is
    // not the same as being permitted to use it - confirmed against a live run where
    // Edit/Write were auto-denied without --allowedTools also granting them.
    assert.ok(invocation.args.includes("--allowedTools"));
    const allowedToolsIndex = invocation.args.indexOf("--allowedTools");
    assert.equal(invocation.args[allowedToolsIndex + 1], "Read,Edit,Write,Grep,Glob");
  });

  it("only includes --bare when bareMode is explicitly opted into", () => {
    const cli = fakeCli("2.1.177");
    const adapter = new ClaudeCliAdapter({
      executable: process.execPath,
      baseArgs: [cli],
      testedVersionRanges: ["2.1.x"],
      requiresCapabilitySmokeTest: false,
      bareMode: true
    });
    const invocation = adapter.buildExecInvocation({
      runId: "run-claude",
      taskId: "TASK-01",
      executionId: "exec-1",
      sessionId: "session-1",
      worktreePath: "C:/repo/worktree",
      prompt: "Implement task.",
      startedAt: "2026-08-01T10:00:00Z"
    });

    assert.ok(invocation.args.includes("--bare"));
  });

  it("only enables Claude bypass permissions when explicitly configured", () => {
    const cli = fakeCli("2.1.177");
    const adapter = new ClaudeCliAdapter({
      executable: process.execPath,
      baseArgs: [cli],
      testedVersionRanges: ["2.1.x"],
      requiresCapabilitySmokeTest: false,
      permissionMode: "bypassPermissions",
      dangerouslySkipPermissions: true
    });
    const invocation = adapter.buildExecInvocation({
      runId: "run-claude",
      taskId: "TASK-01",
      executionId: "exec-1",
      sessionId: "session-1",
      worktreePath: "C:/repo/worktree",
      prompt: "Implement task.",
      startedAt: "2026-08-01T10:00:00Z"
    });

    assert.ok(invocation.args.includes("--permission-mode"));
    assert.ok(invocation.args.includes("bypassPermissions"));
    assert.ok(invocation.args.includes("--dangerously-skip-permissions"));
  });

  it("runs a fake Claude CLI end to end and returns a schema-valid agent result", () => {
    const cli = fakeCli("2.1.177", { touchedFile: join(tmpdir(), "aicw-claude-touch.txt") });
    tempRoots.push(join(tmpdir(), "aicw-claude-touch.txt"));
    const adapter = new ClaudeCliAdapter({
      executable: process.execPath,
      baseArgs: [cli],
      testedVersionRanges: ["2.1.x"],
      requiresCapabilitySmokeTest: false
    });
    const execution = adapter.start({
      runId: "run-claude",
      taskId: "TASK-01",
      executionId: "exec-1",
      sessionId: "session-1",
      worktreePath: process.cwd(),
      prompt: "Implement task.",
      startedAt: "2026-08-01T10:00:00Z"
    });

    assert.equal(execution.result.status, "DONE");
    assert.equal(execution.events.length, 3);
    assert.equal(execution.events[0]?.type, "execution.started");
    assert.equal(execution.events[1]?.type, "session.bound");
    assert.equal(execution.events[2]?.type, "execution.completed");
  });

  it("can execute two Claude adapter invocations concurrently through startAsync", async () => {
    const cli = fakeCli("2.1.177", { delayMs: 1000 });
    const adapter = new ClaudeCliAdapter({
      executable: process.execPath,
      baseArgs: [cli],
      testedVersionRanges: ["2.1.x"],
      requiresCapabilitySmokeTest: false,
      timeoutMs: 5000
    });
    const startedAt = Date.now();
    const [first, second] = await Promise.all([
      adapter.startAsync(startRequest("exec-1", "TASK-01")),
      adapter.startAsync(startRequest("exec-2", "TASK-02"))
    ]);

    assert.equal(first.result.status, "DONE");
    assert.equal(second.result.status, "DONE");
    assert.ok(Date.now() - startedAt < 8000);
    assert.equal(first.events[0]?.payload.async, true);
  });

  it("fails closed (never throws) when the engine result is invalid JSON", () => {
    const cli = fakeCli("2.1.177", { emitInvalidJson: true });
    const adapter = new ClaudeCliAdapter({
      executable: process.execPath,
      baseArgs: [cli],
      testedVersionRanges: ["2.1.x"],
      requiresCapabilitySmokeTest: false
    });
    const execution = adapter.start({
      runId: "run-claude",
      taskId: "TASK-01",
      executionId: "exec-1",
      sessionId: "session-1",
      worktreePath: process.cwd(),
      prompt: "Implement task.",
      startedAt: "2026-08-01T10:00:00Z"
    });

    assert.equal(execution.result.status, "FAILED");
    assert.equal(execution.events.at(-1)?.type, "execution.failed");
  });

  it("extracts the JSON object when the model wraps it in prose (confirmed real-world case)", () => {
    const cli = fakeCli("2.1.177", { wrapResultInProse: true });
    const adapter = new ClaudeCliAdapter({
      executable: process.execPath,
      baseArgs: [cli],
      testedVersionRanges: ["2.1.x"],
      requiresCapabilitySmokeTest: false
    });
    const execution = adapter.start({
      runId: "run-claude",
      taskId: "TASK-01",
      executionId: "exec-1",
      sessionId: "session-1",
      worktreePath: process.cwd(),
      prompt: "Implement task.",
      startedAt: "2026-08-01T10:00:00Z"
    });

    assert.equal(execution.result.status, "DONE");
    assert.equal(execution.result.runId, "run-claude");
    assert.equal(execution.result.taskId, "TASK-01");
  });

  it("parses real per-call token usage from the --output-format json envelope", () => {
    const cli = fakeCli("2.1.177");
    const adapter = new ClaudeCliAdapter({
      executable: process.execPath,
      baseArgs: [cli],
      testedVersionRanges: ["2.1.x"],
      requiresCapabilitySmokeTest: false
    });
    const execution = adapter.start({
      runId: "run-claude",
      taskId: "TASK-01",
      executionId: "exec-1",
      sessionId: "session-1",
      worktreePath: process.cwd(),
      prompt: "Implement task.",
      startedAt: "2026-08-01T10:00:00Z"
    });

    // Defaults baked into writeFakeClaudeCli's usage object, matching the real
    // --output-format json envelope shape confirmed live in
    // docs/HANDOFF-BENCHMARK-TOOL-AND-PHASE-4.md: input_tokens already excludes cached
    // tokens, so it maps straight to inputUncachedTokens.
    assert.deepEqual(execution.usage, {
      inputUncachedTokens: 120,
      cacheReadTokens: 4500,
      cacheWriteTokens: 30,
      outputTokens: 200,
      costUsd: 0.0123
    });
  });

  it("parses token usage against a captured real --output-format json sample", () => {
    const cli = fakeCliReplaying("2.1.177", "tests/fixtures/engine-usage/claude-output-format-json.sample.json");
    const adapter = new ClaudeCliAdapter({
      executable: process.execPath,
      baseArgs: [cli],
      testedVersionRanges: ["2.1.x"],
      requiresCapabilitySmokeTest: false
    });
    const execution = adapter.start({
      runId: "run-claude",
      taskId: "TASK-01",
      executionId: "exec-1",
      sessionId: "session-1",
      worktreePath: process.cwd(),
      prompt: "Implement task.",
      startedAt: "2026-08-01T10:00:00Z"
    });

    assert.equal(execution.result.status, "DONE");
    assert.deepEqual(execution.usage, {
      inputUncachedTokens: 4,
      cacheReadTokens: 15420,
      cacheWriteTokens: 1823,
      outputTokens: 612,
      costUsd: 0.0842
    });
  });

  it("falls back to unknown usage when the CLI output has no usage field", () => {
    const cli = fakeCli("2.1.177", { emitInvalidJson: true });
    const adapter = new ClaudeCliAdapter({
      executable: process.execPath,
      baseArgs: [cli],
      testedVersionRanges: ["2.1.x"],
      requiresCapabilitySmokeTest: false
    });
    const execution = adapter.start({
      runId: "run-claude",
      taskId: "TASK-01",
      executionId: "exec-1",
      sessionId: "session-1",
      worktreePath: process.cwd(),
      prompt: "Implement task.",
      startedAt: "2026-08-01T10:00:00Z"
    });

    assert.deepEqual(execution.usage, {
      inputUncachedTokens: null,
      cacheReadTokens: null,
      cacheWriteTokens: null,
      outputTokens: null,
      costUsd: null
    });
  });

  it("extracts the JSON object when the wrapping prose itself contains stray braces (confirmed real-world case)", () => {
    const cli = fakeCli("2.1.177", { wrapResultWithStrayBraces: true });
    const adapter = new ClaudeCliAdapter({
      executable: process.execPath,
      baseArgs: [cli],
      testedVersionRanges: ["2.1.x"],
      requiresCapabilitySmokeTest: false
    });
    const execution = adapter.start({
      runId: "run-claude",
      taskId: "TASK-01",
      executionId: "exec-1",
      sessionId: "session-1",
      worktreePath: process.cwd(),
      prompt: "Implement task.",
      startedAt: "2026-08-01T10:00:00Z"
    });

    assert.equal(execution.result.status, "DONE");
    assert.equal(execution.result.runId, "run-claude");
    assert.equal(execution.result.taskId, "TASK-01");
  });
});

function fakeCli(
  version: string,
  options: {
    readonly supportsPrintHelp?: boolean;
    readonly touchedFile?: string;
    readonly emitInvalidJson?: boolean;
    readonly wrapResultInProse?: boolean;
    readonly wrapResultWithStrayBraces?: boolean;
    readonly delayMs?: number;
  } = {}
): string {
  const root = mkdtempSync(join(tmpdir(), "aicw-fake-claude-"));
  tempRoots.push(root);
  const cli = join(root, "claude-fake.mjs");

  if (options.emitInvalidJson) {
    writeFileSync(
      cli,
      `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args.includes("--version")) {
  console.log("${version} (Claude Code)");
  process.exit(0);
}
if (args[0] === "-p" && args.includes("--help")) {
  console.log("--output-format --json-schema --tools --allowedTools --permission-mode --bare --session-id --no-session-persistence --input-format stream-json");
  process.exit(0);
}
if (args[0] === "-p") {
  console.log("not-json");
  process.exit(0);
}
process.exit(2);
`,
      "utf8"
    );
  } else {
    writeFakeClaudeCli(cli, {
      version,
      supportsPrintHelp: options.supportsPrintHelp,
      touchedFile: options.touchedFile,
      wrapResultInProse: options.wrapResultInProse,
      wrapResultWithStrayBraces: options.wrapResultWithStrayBraces,
      delayMs: options.delayMs
    });
  }

  chmodSync(cli, 0o755);
  return cli;
}

/** Spawns a fake CLI that ignores its input and replays a captured real JSON sample
 *  verbatim on stdout - used to test usage parsing against real, previously-captured
 *  output shapes without ever invoking a real `claude` CLI from a test. */
function fakeCliReplaying(version: string, fixturePath: string): string {
  const root = mkdtempSync(join(tmpdir(), "aicw-fake-claude-replay-"));
  tempRoots.push(root);
  const cli = join(root, "claude-fake-replay.mjs");
  writeFileSync(
    cli,
    `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args.includes("--version")) {
  console.log("${version} (Claude Code)");
  process.exit(0);
}
if (args[0] === "-p") {
  const fs = await import("node:fs");
  process.stdout.write(fs.readFileSync(${JSON.stringify(fixturePath)}, "utf8"));
  process.exit(0);
}
process.exit(2);
`,
    "utf8"
  );
  chmodSync(cli, 0o755);
  return cli;
}

function startRequest(executionId: string, taskId: string) {
  return {
    runId: "run-claude",
    taskId,
    executionId,
    sessionId: `${executionId}-session`,
    worktreePath: process.cwd(),
    prompt: JSON.stringify({ runId: "run-claude", taskId }),
    startedAt: "2026-08-01T10:00:00Z"
  };
}
