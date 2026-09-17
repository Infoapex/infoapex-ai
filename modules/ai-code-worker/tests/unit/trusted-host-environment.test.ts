import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { resolveExecutionEnvironment, TrustedHostExecutionEnvironment } from "../../src/execution/environment.js";
import type { EngineProcessOptions, EngineProcessRunner } from "../../src/engines/process-runner.js";

const profile = () => JSON.parse(readFileSync("templates/project/.ai-code-worker/execution-environment.trusted-host.example.json", "utf8"));
const options = (): EngineProcessOptions => ({ cwd: process.cwd(), timeoutMs: 5_000, maximumOutputBytes: 4096 });

describe("explicit trusted-host environment", () => {
  it("reports host permissions, not OS isolation, and requires an enabled provider", () => {
    const p = profile();
    const environment = resolveExecutionEnvironment(p);
    assert.ok(environment instanceof TrustedHostExecutionEnvironment);
    const report = environment.doctor(p);
    assert.equal(report.backend, "trusted-host");
    assert.equal(report.supported, true);
    assert.equal(report.providerSupported, true);
    assert.equal(report.securityBoundary, "host-process");
    assert.deepEqual(report.capabilities, ["environment-scrubbed", "output-limits"]);
    assert.ok(report.warnings.some(w => w.includes("no OS isolation")));
    assert.equal(environment.providerProcessRunner?.(p, "claude"), null);
  });

  it("does not silently enable the default profile", () => {
    const p = JSON.parse(readFileSync("templates/project/.ai-code-worker/execution-environment.example.json", "utf8"));
    assert.equal(resolveExecutionEnvironment(p).doctor(p).providerSupported, false);
  });

  for (const variant of ["missing-ack", "false-ack", "isolated-kind", "deny-filesystem", "deny-network", "docker", "missing-providers"]) {
    it(`rejects contradictory or unauthorized profile: ${variant}`, () => {
      const p = profile();
      if (variant === "missing-ack") delete p.providerExecution.acknowledgeHostAccess;
      if (variant === "false-ack") p.providerExecution.acknowledgeHostAccess = false;
      if (variant === "isolated-kind") p.kind = "isolated";
      if (variant === "deny-filesystem") p.filesystem.hostWriteDefault = "deny";
      if (variant === "deny-network") p.network.repositoryProcesses = "deny";
      if (variant === "docker") p.backend = { type: "docker", image: "node", imageDigest: `sha256:${"a".repeat(64)}` };
      if (variant === "missing-providers") delete p.providerExecution.providers;
      assert.throws(() => resolveExecutionEnvironment(p));
    });
  }

  it("refuses credentials not included in the explicit environment allowlist", () => {
    const p = profile();
    p.providerExecution.credentialVariables = ["AICW_TEST_CREDENTIAL"];
    assert.equal(resolveExecutionEnvironment(p).doctor(p).supported, false);
  });

  it("delivers stdin to a real local process through the provider runner", () => {
    const p = profile();
    const runner = resolveExecutionEnvironment(p).providerProcessRunner!(p, "codex")!;
    const result = runner.runSync(process.execPath, ["-e", "process.stdin.pipe(process.stdout)"], { ...options(), input: "prompt cu diacritice: șțâ\n" });
    assert.equal(result.status, 0);
    assert.equal(result.stdout, "prompt cu diacritice: șțâ\n");
  });

  it("scrubs unapproved environment values in real repository commands", () => {
    const p = profile();
    const result = resolveExecutionEnvironment(p).runWithProfileSync!(p, {
      ...options(), executable: process.execPath,
      args: ["-e", "process.stdout.write(process.env.CI === 'true' && !process.env.AICW_TEST_PRIVATE ? 'clean' : 'leaked')"],
      env: { CI: "true", AICW_TEST_PRIVATE: "synthetic-value" }
    });
    assert.equal(result.status, 0);
    assert.equal(result.stdout, "clean");
  });

  it("clamps sync and async time/output including an outer watchdog", async () => {
    const p = profile();
    p.limits.maximumDurationSeconds = 1;
    p.limits.maximumOutputBytes = 512;
    const calls: EngineProcessOptions[] = [];
    const stub: EngineProcessRunner = {
      runSync(_exe, _args, opts) { calls.push(opts); return { status: 0, stdout: "", stderr: "", pid: 1, signal: null, output: [null, "", ""] }; },
      async runAsync(_exe, _args, opts) { calls.push(opts); return { status: 0, stdout: "", stderr: "", error: null, timedOut: false, stopReason: null, outputTruncated: false }; }
    };
    const runner = new TrustedHostExecutionEnvironment(undefined, stub).providerProcessRunner(p, "codex")!;
    const opts = { ...options(), env: { CI: "true", AICW_TEST_PRIVATE: "synthetic" },
      watchdog: { maximumRuntimeMs: 90_000, idleTimeoutMs: 30_000, maximumRepeatedProgressEvents: 4 } };
    runner.runSync("test", [], opts);
    await runner.runAsync("test", [], opts);
    for (const call of calls) {
      assert.equal(call.timeoutMs, 1000);
      assert.equal(call.maximumOutputBytes, 512);
      assert.equal(call.watchdog?.maximumRuntimeMs, 1000);
      assert.deepEqual(call.env, { CI: "true" });
    }
  });

  it("keeps allowlisted host PATH for gates with an explicit empty environment", () => {
    const p = profile();
    const calls: EngineProcessOptions[] = [];
    const stub: EngineProcessRunner = {
      runSync(_exe, _args, opts) { calls.push(opts); return { status: 0, stdout: "", stderr: "", pid: 1, signal: null, output: [null, "", ""] }; },
      async runAsync() { throw new Error("Unexpected async call"); }
    };
    const environment = new TrustedHostExecutionEnvironment(undefined, stub);
    environment.runWithProfileSync(p, { ...options(), executable: "node", args: ["--version"], env: {} });
    const hostPath = process.env.Path ?? process.env.PATH;
    assert.ok(hostPath);
    assert.equal(calls[0].env?.Path ?? calls[0].env?.PATH, hostPath);
    p.environment.allowedVariables = p.environment.allowedVariables.filter((name: string) => name.toUpperCase() !== "PATH");
    environment.runWithProfileSync(p, { ...options(), executable: "node", args: ["--version"], env: {} });
    assert.equal(calls[1].env?.Path ?? calls[1].env?.PATH, undefined);
  });

  it("terminates a bounded asynchronous local process", async () => {
    const p = profile();
    const runner = resolveExecutionEnvironment(p).providerProcessRunner!(p, "codex")!;
    const result = await runner.runAsync(process.execPath, ["-e", "setTimeout(()=>{}, 10000)"], { ...options(), timeoutMs: 100 });
    assert.equal(result.timedOut, true);
    assert.notEqual(result.status, 0);
  });
});
