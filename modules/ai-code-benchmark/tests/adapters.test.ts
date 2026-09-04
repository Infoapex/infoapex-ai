import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { DirectClaudeAdapter, DirectCodexAdapter, FakeAdapter, InfoapexRootAdapter } from "../src/adapters/index.js";
import { collectCandidateTelemetry } from "../src/adapters/infoapex-root.js";
import { safeEnvironment } from "../src/adapters/subprocess.js";
import type { AdapterRequest } from "../src/types.js";

const root = mkdtempSync(join(tmpdir(), "ai-code-benchmark-adapters-"));
test.after(() => rmSync(root, { recursive: true, force: true }));

function request(overrides: Partial<AdapterRequest> = {}): AdapterRequest {
  return {
    arm: "direct",
    repositoryPath: root,
    taskId: "task-001",
    seed: 11,
    prompt: "change only the requested file",
    provider: "codex",
    model: "test-model",
    effort: "high",
    permissions: { sandbox: "workspace-write", mode: "dontAsk", allowedTools: ["Read", "Edit"] },
    limits: { timeoutMs: 1_000, maximumOutputBytes: 32_768 },
    ...overrides
  };
}

function fakeCli(name: "codex" | "claude" | "infoapex", mode: "normal" | "malformed" | "slow" | "large" | "tree" = "normal", capturePath?: string): string {
  const path = join(root, `${name}-${mode}-${Math.random().toString(16).slice(2)}.mjs`);
  const source = `
import { readFileSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
const args = process.argv.slice(2);
const role = ${JSON.stringify(name)};
const mode = ${JSON.stringify(mode)};
const capturePath = ${JSON.stringify(capturePath ?? null)};
if (args.includes("--version")) { console.log(role + " fake 1.2.3"); process.exit(0); }
if ((role === "codex" && args[0] === "exec" && args.includes("--help")) ||
    (role === "claude" && args[0] === "-p" && args.includes("--help"))) {
  console.log(role === "codex" ? "exec --json --sandbox --model --config" : "-p --output-format --permission-mode --model --effort"); process.exit(0);
}
if (role === "infoapex" && args.includes("--help")) { console.log("run --repo <path> --plan <path> --engine <engine>"); process.exit(0); }
if (mode === "tree") { spawn(process.execPath, ["-e", "setTimeout(()=>require('node:fs').writeFileSync(" + JSON.stringify(capturePath) + ",'escaped'),2000)"], { stdio: "ignore" }); await new Promise((resolve) => setTimeout(resolve, 5000)); }
if (mode === "slow") await new Promise((resolve) => setTimeout(resolve, 250));
if (capturePath) writeFileSync(capturePath, JSON.stringify({ args, stdin: role === "claude" || role === "codex" && args.at(-1) === "-" ? readFileSync(0, "utf8") : null }));
if (mode === "large") { console.log("x".repeat(10000)); process.exit(0); }
if (mode === "malformed") { console.log("not JSON"); process.exit(0); }
if (role === "codex" && args[0] === "exec") console.log(JSON.stringify({ type: "completed", model: "codex-fake", usage: { input_tokens: 10, cache_read_input_tokens: 20, cache_creation_input_tokens: 3, output_tokens: 5 }, total_cost_usd: 0.02 }));
else if (role === "claude" && args[0] === "-p") console.log(JSON.stringify({ result: "done", model: "claude-fake", usage: { input_tokens: 11, cache_read_input_tokens: 21, cache_creation_input_tokens: 4, output_tokens: 6 }, total_cost_usd: 0.03 }));
else if (role === "infoapex" && args[0] === "run") console.log(JSON.stringify({ schemaVersion: "1.0", status: "DONE", body: { model: "infoapex-fake", usage: { input_tokens: 12, cache_read_input_tokens: 22, cache_creation_input_tokens: 5, output_tokens: 7, total_cost_usd: 0.04 } } }));
else process.exit(2);
`;
  writeFileSync(path, source, "utf8");
  return path;
}

test("direct Codex fake CLI E2E keeps the prompt off argv and cannot turn it into shell syntax", async () => {
  const capture = join(root, "codex-capture.json");
  const adapter = new DirectCodexAdapter([process.execPath, fakeCli("codex", "normal", capture)]);
  const payload = "literal; $(New-Item -Path injected-marker)";
  const result = await adapter.execute(request({ prompt: payload }));
  assert.equal(result.status, "DONE");
  assert.equal(result.adapter.parserVersion, "codex-jsonl.v1");
  assert.equal(result.execution.model, "codex-fake");
  assert.equal(result.usage.totalTokens, 38);
  assert.equal(result.termination.exitCode, 0);
  assert.match(result.output.rawOutputSha256, /^[a-f0-9]{64}$/);
  assert.deepEqual(Object.keys(result).sort(), ["adapter", "execution", "message", "output", "status", "termination", "timing", "usage"]);
  assert.equal(existsSync(join(root, "injected-marker")), false);
  const captured = JSON.parse(readFileSync(capture, "utf8"));
  assert.equal(captured.args.at(-1), "-");
  assert.equal(captured.stdin, payload);
});

test("direct Claude fake CLI E2E uses stdin and preserves unknown usage as null", async () => {
  const capture = join(root, "claude-capture.json");
  const adapter = new DirectClaudeAdapter([process.execPath, fakeCli("claude", "normal", capture)]);
  const result = await adapter.execute(request({ provider: "claude", prompt: "private prompt stays off argv" }));
  assert.equal(result.status, "DONE");
  assert.equal(result.adapter.parserVersion, "claude-result.v1");
  assert.equal(result.execution.model, "claude-fake");
  assert.equal(result.usage.inputUncachedTokens, 11);
  assert.equal(JSON.parse(readFileSync(capture, "utf8")).stdin, "private prompt stays off argv");
  const fake = await new FakeAdapter("done").execute(request({ provider: "fake", model: null }));
  assert.equal(fake.usage.costUsd, 0);
});

test("Infoapex root fake CLI E2E accepts only explicit public B/C/D configuration", async () => {
  const plan = join(root, "plan.md");
  const prompt = request().prompt;
  writeFileSync(plan, `---\nstatus: accepted\n---\n\n\`\`\`json ai-code-worker-plan\n${JSON.stringify({ workerContractVersion: "1.1", goal: prompt, tasks: [{ role: prompt, acceptanceCriteria: [prompt], traceability: { acceptanceCriteria: [{ text: prompt }] } }] })}\n\`\`\`\n`, "utf8");
  const configDirectory = join(root, ".ai-code-worker");
  mkdirSync(configDirectory, { recursive: true });
  const adapter = new InfoapexRootAdapter([process.execPath, fakeCli("infoapex")]);
  writeFileSync(join(configDirectory, "config.json"), JSON.stringify({ contextProvider: "none", contextPackage: { mode: "off", maximumTokens: 100 } }), "utf8");
  const noIcm = await adapter.execute(request({ arm: "orchestrated-no-icm", provider: "fake", orchestrationPlanPath: plan, armConfiguration: { contextProvider: "none", contextPackageMode: "off" } }));
  assert.equal(noIcm.status, "DONE");
  writeFileSync(join(configDirectory, "config.json"), JSON.stringify({ contextProvider: "ai-code-control", contextPackage: { mode: "enforce", maximumTokens: 100 } }), "utf8");
  const full = await adapter.execute(request({ arm: "full-icm", provider: "fake", orchestrationPlanPath: plan, armConfiguration: { contextProvider: "ai-code-control", contextPackageMode: "enforce" } }));
  assert.equal(full.status, "DONE");
  const candidate = await adapter.execute(request({ arm: "candidate", provider: "fake", orchestrationPlanPath: plan, armConfiguration: { contextProvider: "ai-code-control", contextPackageMode: "enforce", candidateCapability: "otel-redaction" } }));
  assert.equal(candidate.status, "DONE");
  const mismatch = await adapter.execute(request({ arm: "orchestrated-no-icm", provider: "fake", orchestrationPlanPath: plan, armConfiguration: { contextProvider: "ai-code-control", contextPackageMode: "enforce" } }));
  assert.equal(mismatch.status, "UNSUPPORTED");
  const taskIdOnly = join(root, "task-id-only.md");
  writeFileSync(taskIdOnly, readFileSync(plan, "utf8").replaceAll(prompt, "task-001"), "utf8");
  const promptLoss = await adapter.execute(request({ arm: "full-icm", provider: "fake", orchestrationPlanPath: taskIdOnly, armConfiguration: { contextProvider: "ai-code-control", contextPackageMode: "enforce" } }));
  assert.equal(promptLoss.status, "UNSUPPORTED");
  assert.match(promptLoss.message, /exact frozen generic task prompt/);
});

test("Infoapex root materializes public worker commits into the evaluator workspace", async () => {
  const repo = mkdtempSync(join(tmpdir(), "ai-code-benchmark-infoapex-materialize-"));
  const cli = join(repo, "fake-infoapex.mjs");
  const plan = join(repo, "plan.md");
  const source = join(repo, "source.txt");
  const prompt = "materialize the worker commit";
  mkdirSync(join(repo, ".ai-code-worker"), { recursive: true });
  writeFileSync(join(repo, ".ai-code-worker", "config.json"), JSON.stringify({ contextProvider: "none", contextPackage: { mode: "off" } }), "utf8");
  writeFileSync(plan, `---\nstatus: accepted\n---\n\n\`\`\`json ai-code-worker-plan\n${JSON.stringify({ workerContractVersion: "1.1", goal: prompt, tasks: [{ role: prompt, acceptanceCriteria: [prompt], traceability: { acceptanceCriteria: [{ text: prompt }] } }] })}\n\`\`\`\n`, "utf8");
  writeFileSync(source, "before\n", "utf8");
  execFileSync("git", ["init", "--quiet"], { cwd: repo });
  execFileSync("git", ["-c", "user.name=benchmark", "-c", "user.email=benchmark@localhost", "add", "."], { cwd: repo });
  execFileSync("git", ["-c", "user.name=benchmark", "-c", "user.email=benchmark@localhost", "commit", "--quiet", "-m", "baseline"], { cwd: repo });
  writeFileSync(source, "after\n", "utf8");
  execFileSync("git", ["add", "source.txt"], { cwd: repo });
  execFileSync("git", ["-c", "user.name=benchmark", "-c", "user.email=benchmark@localhost", "commit", "--quiet", "-m", "worker task"], { cwd: repo });
  const taskCommit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim();
  execFileSync("git", ["reset", "--hard", "HEAD^"], { cwd: repo, stdio: "ignore" });
  writeFileSync(cli, `const args = process.argv.slice(2);\nif (args.includes("--version")) console.log("fake 1.0");\nelse if (args.includes("--help")) console.log("run --repo --plan --engine");\nelse console.log(JSON.stringify({ schemaVersion: "1.0", status: "PASS", body: { status: "DONE", executedTasks: ["TASK-1"], taskCommits: { "TASK-1": ${JSON.stringify(taskCommit)} } } }));\n`, "utf8");

  const adapter = new InfoapexRootAdapter([process.execPath, cli]);
  const result = await adapter.execute(request({ arm: "orchestrated-no-icm", repositoryPath: repo, prompt, provider: "fake", orchestrationPlanPath: plan, armConfiguration: { contextProvider: "none", contextPackageMode: "off" } }));
  assert.equal(result.status, "DONE");
  assert.equal(readFileSync(source, "utf8").replaceAll("\r\n", "\n"), "after\n");
  assert.equal(execFileSync("git", ["diff", "--name-only", "HEAD", "--"], { cwd: repo, encoding: "utf8" }).trim(), "source.txt");
});

test("adapters classify timeout, malformed output, output limits, and unsupported requests without fallback", async () => {
  const timeout = await new DirectClaudeAdapter([process.execPath, fakeCli("claude", "slow")]).execute(request({ provider: "claude", limits: { timeoutMs: 20, maximumOutputBytes: 32_768 } }));
  assert.equal(timeout.status, "BLOCKED");
  assert.equal(timeout.termination.timedOut, true);
  const malformed = await new DirectCodexAdapter([process.execPath, fakeCli("codex", "malformed")]).execute(request());
  assert.equal(malformed.status, "BLOCKED");
  assert.match(malformed.message, /malformed structured output/);
  assert.deepEqual(malformed.usage, { inputUncachedTokens: null, cacheReadTokens: null, cacheWriteTokens: null, outputTokens: null, totalTokens: null, costUsd: null });
  const large = await new DirectCodexAdapter([process.execPath, fakeCli("codex", "large")]).execute(request({ limits: { timeoutMs: 1_000, maximumOutputBytes: 100 } }));
  assert.equal(large.status, "BLOCKED");
  assert.equal(large.termination.outputTruncated, true);
  const unsupported = await new DirectCodexAdapter([process.execPath, fakeCli("codex")]).execute(request({ provider: "claude" }));
  assert.equal(unsupported.status, "UNSUPPORTED");
  assert.match(unsupported.message, /no fallback/);
});

test("timeout terminates the provider process tree, not only its direct parent", async () => {
  const escaped = join(root, `escaped-${Math.random().toString(16).slice(2)}`);
  const result = await new DirectCodexAdapter([process.execPath, fakeCli("codex", "tree", escaped)]).execute(request({ limits: { timeoutMs: 40, maximumOutputBytes: 32_768 } }));
  assert.equal(result.termination.timedOut, true);
  await new Promise((resolve) => setTimeout(resolve, 2200));
  assert.equal(existsSync(escaped), false);
});

test("environment forwarding is allowlisted and secret-looking names are always redacted", () => {
  const priorPublic = process.env.BENCH_PUBLIC_VALUE;
  const priorSecret = process.env.BENCH_API_KEY;
  process.env.BENCH_PUBLIC_VALUE = "visible-to-child";
  process.env.BENCH_API_KEY = "must-not-forward";
  try {
    const environment = safeEnvironment(["BENCH_PUBLIC_VALUE", "BENCH_API_KEY", "BAD-NAME"]);
    assert.equal(environment.environment.BENCH_PUBLIC_VALUE, "visible-to-child");
    assert.equal(environment.environment.BENCH_API_KEY, undefined);
    assert.equal(environment.forwarded.includes("BENCH_API_KEY"), false);
  } finally {
    if (priorPublic === undefined) delete process.env.BENCH_PUBLIC_VALUE; else process.env.BENCH_PUBLIC_VALUE = priorPublic;
    if (priorSecret === undefined) delete process.env.BENCH_API_KEY; else process.env.BENCH_API_KEY = priorSecret;
  }
});

test("candidate telemetry evidence is aggregate-only and detects unsafe span attributes", () => {
  const repository = mkdtempSync(join(tmpdir(), "ai-code-benchmark-otel-evidence-"));
  const state = join(repository, "worker-state"); const runRoot = join(state, "run-one");
  mkdirSync(join(repository, ".ai-code-worker"), { recursive: true }); mkdirSync(runRoot, { recursive: true });
  writeFileSync(join(repository, ".ai-code-worker", "config.json"), JSON.stringify({ stateRoot: state }), "utf8");
  writeFileSync(join(runRoot, "events.jsonl"), [
    JSON.stringify({ type: "task.started", payload: { taskId: "TASK-1" } }),
    JSON.stringify({ type: "task.finished", payload: { taskId: "TASK-1" } })
  ].join("\n") + "\n", "utf8");
  writeFileSync(join(runRoot, "otel-spans.jsonl"), JSON.stringify({ name: "task", attributes: { taskId: "TASK-1", unexpectedPath: "C:\\Users\\private\\source.txt" } }) + "\n", "utf8");
  const output = JSON.stringify({ status: "PASS", body: { status: "DONE", state: { runRoot, eventLogPath: join(runRoot, "events.jsonl") } } });
  const evidence = collectCandidateTelemetry(output, request({ arm: "candidate", repositoryPath: repository }));
  assert.ok(evidence); assert.equal(evidence.eventCount, 2); assert.equal(evidence.eligibleTraceUnits, 1); assert.equal(evidence.exportedSpans, 1); assert.equal(evidence.eligibleTraceCoverage, 1); assert.equal(evidence.telemetryLeakageCount, 2); assert.match(evidence.evidenceSha256, /^[a-f0-9]{64}$/u);
  assert.deepEqual(Object.keys(evidence).sort(), ["eligibleTraceCoverage", "eligibleTraceUnits", "eventCount", "evidenceSha256", "exportedSpans", "telemetryLeakageCount"]);
});

test("candidate telemetry accepts the worker's current platform-default state layout", () => {
  const repository = mkdtempSync(join(tmpdir(), "ai-code-benchmark-otel-default-")); const local = mkdtempSync(join(tmpdir(), "ai-code-benchmark-local-state-"));
  const runRoot = join(local, "ai-code-worker", "repos", "a".repeat(16), "runs", "run-default"); mkdirSync(runRoot, { recursive: true }); mkdirSync(join(repository, ".ai-code-worker"), { recursive: true });
  writeFileSync(join(repository, ".ai-code-worker", "config.json"), JSON.stringify({ stateRoot: join(repository, "declared-state") }), "utf8");
  writeFileSync(join(runRoot, "events.jsonl"), JSON.stringify({ type: "run.done", payload: { tasks: ["TASK-1"] } }) + "\n", "utf8");
  writeFileSync(join(runRoot, "otel-spans.jsonl"), JSON.stringify({ name: "run.done", attributes: { tasks: ["TASK-1"] } }) + "\n", "utf8");
  const prior = process.env.LOCALAPPDATA; process.env.LOCALAPPDATA = local;
  try {
    const evidence = collectCandidateTelemetry(JSON.stringify({ body: { state: { runRoot, eventLogPath: join(runRoot, "events.jsonl") } } }), request({ arm: "candidate", repositoryPath: repository }));
    assert.equal(evidence?.eligibleTraceCoverage, 1); assert.equal(evidence?.telemetryLeakageCount, 0);
  } finally { if (prior === undefined) delete process.env.LOCALAPPDATA; else process.env.LOCALAPPDATA = prior; }
});

test("CLI doctor reports configured adapter probes without running a task", () => {
  const repo = mkdtempSync(join(root, "doctor-"));
  const configDirectory = join(repo, ".ai-code-benchmark");
  mkdirSync(configDirectory, { recursive: true });
  const codex = fakeCli("codex");
  const claude = fakeCli("claude");
  const infoapex = fakeCli("infoapex");
  writeFileSync(join(configDirectory, "config.json"), JSON.stringify({ schemaVersion: "1.0", stateRoot: null, commands: { codex: [process.execPath, codex], claude: [process.execPath, claude], infoapex: [process.execPath, infoapex], aiCodeControl: [process.execPath, infoapex] }, capabilities: { liveExecution: false, networkExpansion: false, publish: false, secretForwarding: false } }), "utf8");
  const cli = fileURLToPath(new URL("../src/cli.js", import.meta.url));
  const output = execFileSync(process.execPath, [cli, "doctor", "--repo", repo], { encoding: "utf8" });
  const result = JSON.parse(output) as { details: { adapters: readonly { status: string }[] } };
  assert.deepEqual(result.details.adapters.map((adapter) => adapter.status), ["PASS", "PASS", "PASS"]);
});
