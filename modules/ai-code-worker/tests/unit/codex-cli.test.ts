import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import {
  CODEX_USAGE_PARSER_VERSION,
  CodexCliAdapter,
  parseCodexUsage,
  parseCodexVersion,
  versionMatches,
  writeFakeCodexCli
} from "../../src/engines/codex-cli.js";

const tempRoots: string[] = [];

after(() => {
  for (const root of tempRoots) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("codex cli adapter", () => {
  it("parses the sanitized cumulative token fixture with a versioned parser", () => {
    const usage = parseCodexUsage(readFileSync("tests/fixtures/engine-usage/codex-rollout-token-count.sample.jsonl", "utf8"));

    assert.equal(CODEX_USAGE_PARSER_VERSION, "codex-token-count.v1");
    assert.deepEqual(usage, {
      inputUncachedTokens: 12221,
      cacheReadTokens: 71200,
      cacheWriteTokens: null,
      outputTokens: 2114,
      costUsd: null
    });
  });

  it("accepts a newly discovered version when no static range override is configured", () => {
    const cli = fakeCli("9.9.9");
    const adapter = new CodexCliAdapter({
      executable: process.execPath,
      baseArgs: [cli],
      requiresCapabilitySmokeTest: true
    });

    assert.equal(adapter.doctor().status, "PASS");
  });

  it("parses Codex CLI version output and tested version ranges", () => {
    assert.equal(parseCodexVersion("codex-cli 0.146.0-alpha.3.1"), "0.146.0-alpha.3.1");
    assert.equal(versionMatches("0.146.0-alpha.3.1", "0.146.0-alpha.3.1"), true);
    assert.equal(versionMatches("0.146.1", "0.146.x"), true);
    assert.equal(versionMatches("0.147.0", "0.146.x"), false);
  });

  it("passes doctor only for tested versions with required exec smoke capabilities", () => {
    const cli = fakeCli("0.146.0-alpha.3.1");
    const adapter = new CodexCliAdapter({
      executable: process.execPath,
      baseArgs: [cli],
      testedVersionRanges: ["0.146.0-alpha.3.1"],
      requiresCapabilitySmokeTest: true
    });
    const report = adapter.doctor();

    assert.equal(report.status, "PASS");
    assert.equal(report.parsedVersion, "0.146.0-alpha.3.1");
    assert.equal(report.smokeTest, "PASS");
    assert.equal(report.behavioralSmokeTest, "PASS");
  });

  it("fails closed for untested versions", () => {
    const cli = fakeCli("0.147.0");
    const adapter = new CodexCliAdapter({
      executable: process.execPath,
      baseArgs: [cli],
      testedVersionRanges: ["0.146.x"],
      requiresCapabilitySmokeTest: true
    });
    const report = adapter.doctor();

    assert.equal(report.status, "BLOCKED");
    assert.equal(report.findings[0]?.code, "CODEX_VERSION_UNTESTED");
  });

  it("fails closed when the smoke test does not expose required capabilities", () => {
    const cli = fakeCli("0.146.0-alpha.3.1", { supportsExecHelp: false });
    const adapter = new CodexCliAdapter({
      executable: process.execPath,
      baseArgs: [cli],
      testedVersionRanges: ["0.146.0-alpha.3.1"],
      requiresCapabilitySmokeTest: true
    });
    const report = adapter.doctor();

    assert.equal(report.status, "BLOCKED");
    assert.equal(report.findings.at(-1)?.code, "CODEX_SMOKE_TEST_FAILED");
  });

  it("builds non-interactive exec invocations without --output-schema and with workspace sandbox", () => {
    const cli = fakeCli("0.146.0-alpha.3.1");
    const adapter = new CodexCliAdapter({
      executable: process.execPath,
      baseArgs: [cli],
      testedVersionRanges: ["0.146.0-alpha.3.1"],
      requiresCapabilitySmokeTest: false,
      defaultModel: "gpt-test",
      reasoningEffort: "high"
    });
    const invocation = adapter.buildExecInvocation({
      runId: "run-codex",
      taskId: "TASK-01",
      executionId: "exec-1",
      sessionId: "session-1",
      worktreePath: "C:/repo/worktree",
      prompt: "Implement task.",
      startedAt: "2026-08-01T10:00:00Z"
    });

    assert.equal(invocation.executable, process.execPath);
    assert.ok(invocation.args.includes("exec"));
    assert.ok(!invocation.args.includes("--ignore-user-config"));
    assert.ok(!invocation.args.includes("--ignore-rules"));
    assert.ok(invocation.args.includes("--json"));
    assert.ok(invocation.args.includes("--cd"));
    assert.ok(invocation.args.includes("--sandbox"));
    assert.ok(invocation.args.includes("workspace-write"));
    assert.ok(invocation.args.includes("--model"));
    assert.ok(invocation.args.includes('model_reasoning_effort="high"'));
    assert.ok(invocation.args.indexOf("--model") > invocation.args.indexOf("exec"));
    assert.ok(invocation.args.indexOf("--sandbox") > invocation.args.indexOf("exec"));
    assert.ok(invocation.args.indexOf("-c") > invocation.args.indexOf("exec"));
    assert.equal(invocation.stdin, "Implement task.");

    // --output-schema/--output-last-message are deliberately not used - a live run
    // showed the model reliably misusing the structured-response tool they expose as
    // its first reply, before doing any real work. See the module comment in
    // codex-cli.ts for the full story.
    assert.ok(!invocation.args.includes("--output-schema"));
    assert.ok(!invocation.args.includes("--output-last-message"));
  });

  it("can build a danger-full-access invocation for the local pilot fallback", () => {
    const cli = fakeCli("0.146.0-alpha.3.1");
    const adapter = new CodexCliAdapter({
      executable: process.execPath,
      baseArgs: [cli],
      testedVersionRanges: ["0.146.0-alpha.3.1"],
      requiresCapabilitySmokeTest: false,
      sandboxMode: "danger-full-access"
    });
    const invocation = adapter.buildExecInvocation({
      runId: "run-codex",
      taskId: "TASK-01",
      executionId: "exec-1",
      sessionId: "session-1",
      worktreePath: "C:/repo/worktree",
      prompt: "Implement task.",
      startedAt: "2026-08-01T10:00:00Z"
    });

    assert.ok(invocation.args.includes("--sandbox"));
    assert.ok(invocation.args.includes("danger-full-access"));
  });

  it("keeps the agent result schema compatible with Codex response_format", () => {
    const schema = JSON.parse(readFileSync("schemas/agent-result.schema.json", "utf8"));

    assert.equal(schema.properties.schemaVersion.type, "string");
    assert.equal(schema.properties.status.type, "string");
    assert.equal(schema.properties.failures.items.properties.class.type, "string");
  });

  it("runs a fake Codex CLI end to end and reads the result from the last agent_message", () => {
    const touchedFile = join(mkdtempSync(join(tmpdir(), "aicw-codex-touch-")), "codex-output.txt");
    tempRoots.push(touchedFile);
    const cli = fakeCli("0.146.0-alpha.3.1", { touchedFile });
    const adapter = new CodexCliAdapter({
      executable: process.execPath,
      baseArgs: [cli],
      testedVersionRanges: ["0.146.0-alpha.3.1"],
      requiresCapabilitySmokeTest: false
    });
    const execution = adapter.start({
      runId: "run-codex",
      taskId: "TASK-01",
      executionId: "exec-1",
      sessionId: "session-1",
      worktreePath: process.cwd(),
      prompt: "Implement task.",
      startedAt: "2026-08-01T10:00:00Z"
    });

    assert.equal(execution.result.status, "DONE");
    assert.equal(execution.events.length, 3);
    assert.equal(execution.events[2]?.type, "execution.completed");
  });

  it("can execute two Codex adapter invocations concurrently through startAsync", async () => {
    const cli = fakeCli("0.146.0-alpha.3.1", { delayMs: 1000 });
    const adapter = new CodexCliAdapter({
      executable: process.execPath,
      baseArgs: [cli],
      testedVersionRanges: ["0.146.0-alpha.3.1"],
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

  it("parses real cumulative token usage from event_msg/token_count", () => {
    const cli = fakeCli("0.146.0-alpha.3.1");
    const adapter = new CodexCliAdapter({
      executable: process.execPath,
      baseArgs: [cli],
      testedVersionRanges: ["0.146.0-alpha.3.1"],
      requiresCapabilitySmokeTest: false
    });
    const execution = adapter.start({
      runId: "run-codex",
      taskId: "TASK-01",
      executionId: "exec-1",
      sessionId: "session-1",
      worktreePath: process.cwd(),
      prompt: "Implement task.",
      startedAt: "2026-08-01T10:00:00Z"
    });

    // Defaults baked into writeFakeCodexCli's usage object, matching the real
    // event_msg/token_count shape confirmed live in
    // docs/HANDOFF-BENCHMARK-TOOL-AND-PHASE-4.md: cached_input_tokens is a subset of
    // input_tokens, so it is subtracted out for inputUncachedTokens.
    assert.deepEqual(execution.usage, {
      inputUncachedTokens: 5300 - 4200,
      cacheReadTokens: 4200,
      cacheWriteTokens: null,
      outputTokens: 340,
      costUsd: null
    });
  });

  it("parses cache_write_input_tokens when the CLI includes it (confirmed present on real CLI 0.147.0, P2-B live run 2026-09-02)", () => {
    const cli = fakeCli("0.147.0", { usage: { cacheWriteInputTokens: 128 } });
    const adapter = new CodexCliAdapter({
      executable: process.execPath,
      baseArgs: [cli],
      testedVersionRanges: ["0.147.0"],
      requiresCapabilitySmokeTest: false
    });
    const execution = adapter.start({
      runId: "run-codex",
      taskId: "TASK-01",
      executionId: "exec-1",
      sessionId: "session-1",
      worktreePath: process.cwd(),
      prompt: "Implement task.",
      startedAt: "2026-08-01T10:00:00Z"
    });

    assert.equal(execution.usage.cacheWriteTokens, 128);
  });

  it("parses token usage against a captured real rollout sample, taking the last (cumulative) token_count event", () => {
    const cli = fakeCliReplaying("0.146.0-alpha.3.1", "tests/fixtures/engine-usage/codex-rollout-token-count.sample.jsonl");
    const adapter = new CodexCliAdapter({
      executable: process.execPath,
      baseArgs: [cli],
      testedVersionRanges: ["0.146.0-alpha.3.1"],
      requiresCapabilitySmokeTest: false
    });
    const execution = adapter.start({
      runId: "run-codex",
      taskId: "TASK-01",
      executionId: "exec-1",
      sessionId: "session-1",
      worktreePath: process.cwd(),
      prompt: "Implement task.",
      startedAt: "2026-08-01T10:00:00Z"
    });

    assert.equal(execution.result.status, "DONE");
    assert.deepEqual(execution.usage, {
      inputUncachedTokens: 83421 - 71200,
      cacheReadTokens: 71200,
      cacheWriteTokens: null,
      outputTokens: 2114,
      costUsd: null
    });
  });

  it("falls back to unknown usage when the CLI never emits a token_count event", () => {
    const cli = fakeCli("0.146.0-alpha.3.1", { usage: null });
    const adapter = new CodexCliAdapter({
      executable: process.execPath,
      baseArgs: [cli],
      testedVersionRanges: ["0.146.0-alpha.3.1"],
      requiresCapabilitySmokeTest: false
    });
    const execution = adapter.start({
      runId: "run-codex",
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

  it("extracts the JSON object when the model wraps the final agent_message in prose", () => {
    const cli = fakeCli("0.146.0-alpha.3.1", { wrapResultInProse: true });
    const adapter = new CodexCliAdapter({
      executable: process.execPath,
      baseArgs: [cli],
      testedVersionRanges: ["0.146.0-alpha.3.1"],
      requiresCapabilitySmokeTest: false
    });
    const execution = adapter.start({
      runId: "run-codex",
      taskId: "TASK-01",
      executionId: "exec-1",
      sessionId: "session-1",
      worktreePath: process.cwd(),
      prompt: "Implement task.",
      startedAt: "2026-08-01T10:00:00Z"
    });

    assert.equal(execution.result.status, "DONE");
    assert.equal(execution.result.runId, "run-codex");
  });

  it("fails closed (never throws) when there is no agent_message in the stream", () => {
    const root = mkdtempSync(join(tmpdir(), "aicw-fake-codex-noop-"));
    tempRoots.push(root);
    const cli = join(root, "codex-noop.mjs");
    writeFileSync(
      cli,
      `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args.includes("--version")) { console.log("codex-cli 0.146.0-alpha.3.1"); process.exit(0); }
if (args[0] === "exec" && args.includes("--help")) { console.log("--json\\n--cd\\n--sandbox"); process.exit(0); }
if (args[0] === "exec") { console.log(JSON.stringify({ type: "thread.started" })); process.exit(0); }
process.exit(2);
`,
      "utf8"
    );
    chmodSync(cli, 0o755);

    const adapter = new CodexCliAdapter({
      executable: process.execPath,
      baseArgs: [cli],
      testedVersionRanges: ["0.146.0-alpha.3.1"],
      requiresCapabilitySmokeTest: false
    });
    const execution = adapter.start({
      runId: "run-codex",
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

  it("keeps timed-out provider output out of the public failure finding", async () => {
    const root = mkdtempSync(join(tmpdir(), "aicw-fake-codex-timeout-"));
    tempRoots.push(root);
    const cli = join(root, "codex-timeout.mjs");
    writeFileSync(cli, `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args.includes("--version")) { console.log("codex-cli 0.146.0-alpha.3.1"); process.exit(0); }
if (args[0] === "exec" && args.includes("--help")) { console.log("--json\\n--cd\\n--sandbox"); process.exit(0); }
if (args[0] === "exec") { console.log("PRIVATE_PROVIDER_OUTPUT=must-not-escape"); await new Promise((resolve) => setTimeout(resolve, 1000)); }
`, "utf8");
    chmodSync(cli, 0o755);
    const adapter = new CodexCliAdapter({ executable: process.execPath, baseArgs: [cli], testedVersionRanges: ["0.146.0-alpha.3.1"], requiresCapabilitySmokeTest: false, idleTimeoutMs: 20, maximumRuntimeMs: 100 });
    const execution = await adapter.startAsync(startRequest("exec-timeout", "TASK-TIMEOUT"));

    assert.equal(execution.result.status, "FAILED");
    assert.match(execution.result.failures[0]?.message ?? "", /(idle watchdog|circuit breaker)/i);
    assert.doesNotMatch(execution.result.failures[0]?.message ?? "", /PRIVATE_PROVIDER_OUTPUT/);
  });

  it("allows a long-running provider while its task worktree keeps changing", async () => {
    const root = mkdtempSync(join(tmpdir(), "aicw-fake-codex-worktree-progress-"));
    tempRoots.push(root);
    const cli = join(root, "codex-progress.mjs");
    writeFileSync(cli, `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args.includes("--version")) { console.log("codex-cli 0.146.0-alpha.3.1"); process.exit(0); }
if (args[0] === "exec" && args.includes("--help")) { console.log("--json\\n--cd\\n--sandbox"); process.exit(0); }
if (args[0] === "exec") {
  const fs = await import("node:fs");
  const path = await import("node:path");
  const worktree = args[args.indexOf("--cd") + 1];
  console.log(JSON.stringify({ type: "item.started", item: { type: "command_execution", command: "dotnet restore" } }));
  for (let i = 0; i < 5; i += 1) { await new Promise((r) => setTimeout(r, 35)); fs.writeFileSync(path.join(worktree, "progress.txt"), String(i)); }
  const request = JSON.parse(fs.readFileSync(0, "utf8"));
  console.log(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: JSON.stringify({ schemaVersion: "1.0", runId: request.runId, taskId: request.taskId, status: "DONE", summary: "done", touchedFiles: [], failures: [] }) } }));
  process.exit(0);
}
`, "utf8");
    chmodSync(cli, 0o755);
    const adapter = new CodexCliAdapter({
      executable: process.execPath, baseArgs: [cli], testedVersionRanges: ["0.146.0-alpha.3.1"], requiresCapabilitySmokeTest: false,
      idleTimeoutMs: 80, maximumRuntimeMs: 2_000, maximumRepeatedProgressEvents: 4
    });
    const execution = await adapter.startAsync({ ...startRequest("exec-worktree-progress", "TASK-PROGRESS"), worktreePath: root });
    assert.equal(execution.result.status, "DONE");
  });

  it("stops a provider which repeats the same semantic command", async () => {
    const root = mkdtempSync(join(tmpdir(), "aicw-fake-codex-loop-"));
    tempRoots.push(root);
    const cli = join(root, "codex-loop.mjs");
    writeFileSync(cli, `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args.includes("--version")) { console.log("codex-cli 0.146.0-alpha.3.1"); process.exit(0); }
if (args[0] === "exec" && args.includes("--help")) { console.log("--json\\n--cd\\n--sandbox"); process.exit(0); }
if (args[0] === "exec") { for (let i = 0; i < 10; i += 1) { console.log(JSON.stringify({ type: "item.completed", item: { type: "command_execution", command: "dotnet test" } })); await new Promise((r) => setTimeout(r, 10)); } }
`, "utf8");
    chmodSync(cli, 0o755);
    const adapter = new CodexCliAdapter({
      executable: process.execPath, baseArgs: [cli], testedVersionRanges: ["0.146.0-alpha.3.1"], requiresCapabilitySmokeTest: false,
      idleTimeoutMs: 1_000, maximumRuntimeMs: 2_000, maximumRepeatedProgressEvents: 3
    });
    const execution = await adapter.startAsync({ ...startRequest("exec-loop", "TASK-LOOP"), worktreePath: root });
    assert.equal(execution.result.status, "FAILED");
    assert.match(execution.result.failures[0]?.message ?? "", /loop guard/i);
  });
});

function fakeCli(
  version: string,
  options: {
    readonly supportsExecHelp?: boolean;
    readonly touchedFile?: string;
    readonly wrapResultInProse?: boolean;
    readonly delayMs?: number;
    readonly usage?: { readonly inputTokens?: number; readonly cachedInputTokens?: number; readonly cacheWriteInputTokens?: number; readonly outputTokens?: number } | null;
  } = {}
): string {
  const root = mkdtempSync(join(tmpdir(), "aicw-fake-codex-"));
  tempRoots.push(root);
  const cli = join(root, "codex-fake.mjs");
  writeFakeCodexCli(cli, {
    version,
    supportsExecHelp: options.supportsExecHelp,
    touchedFile: options.touchedFile,
    wrapResultInProse: options.wrapResultInProse,
    delayMs: options.delayMs,
    usage: options.usage
  });
  chmodSync(cli, 0o755);
  return cli;
}

/** Spawns a fake CLI that ignores its input and replays a captured real JSONL sample
 *  verbatim on stdout - used to test usage parsing against real, previously-captured
 *  rollout shapes without ever invoking a real `codex` CLI from a test. */
function fakeCliReplaying(version: string, fixturePath: string): string {
  const root = mkdtempSync(join(tmpdir(), "aicw-fake-codex-replay-"));
  tempRoots.push(root);
  const cli = join(root, "codex-fake-replay.mjs");
  writeFileSync(
    cli,
    `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args.includes("--version")) {
  console.log("codex-cli ${version}");
  process.exit(0);
}
if (args[0] === "exec") {
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
    runId: "run-codex",
    taskId,
    executionId,
    sessionId: `${executionId}-session`,
    worktreePath: process.cwd(),
    prompt: JSON.stringify({ runId: "run-codex", taskId }),
    startedAt: "2026-08-01T10:00:00Z"
  };
}
