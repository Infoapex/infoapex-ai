import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { runQualityGate, runQualityGateSync, toEvidenceCommand } from "../../src/runner/quality-gate.js";
import { redactText } from "../../src/runner/redaction.js";

describe("quality gate runner", () => {
  it("runs a passing command without shell", async () => {
    const result = await runQualityGate({
      id: "node-pass",
      executable: process.execPath,
      args: ["-e", "console.log('ok')"],
      cwd: process.cwd(),
      timeoutMs: 5000,
      maximumOutputBytes: 1024
    });

    assert.equal(result.exitCode, 0);
    assert.equal(result.failureClass, null);
    assert.equal(result.timedOut, false);
    assert.deepEqual(toEvidenceCommand(result), {
      id: "node-pass",
      executable: process.execPath,
      args: ["-e", "console.log('ok')"],
      exitCode: 0,
      durationMs: result.durationMs
    });
  });

  it("keeps PATH available for named executables without inheriting arbitrary host variables", async () => {
    const result = await runQualityGate({
      id: "named-node-pass",
      executable: "node",
      args: ["-e", "process.exit(process.env.PATH ? 0 : 1)"],
      cwd: process.cwd(),
      timeoutMs: 5000,
      maximumOutputBytes: 1024,
      env: { AICW_ALLOWED: "yes" }
    });

    assert.equal(result.exitCode, 0);
    assert.equal(result.failureClass, null);
  });

  it("keeps standard toolchain profile/cache paths while dropping arbitrary host variables", async () => {
    const result = await runQualityGate({
      id: "toolchain-profile",
      executable: process.execPath,
      args: ["-e", "process.exit((process.env.HOME || process.env.USERPROFILE) && (process.env.ProgramData || process.env.PROGRAMDATA || process.platform !== 'win32') && !process.env.AICW_RANDOM_SECRET ? 0 : 1)"],
      cwd: process.cwd(),
      timeoutMs: 5000,
      maximumOutputBytes: 1024
    });

    assert.equal(result.exitCode, 0);
    assert.equal(result.failureClass, null);
  });

  it("executes Windows command shims such as npm.cmd", () => {
    if (process.platform !== "win32") return;

    const result = runQualityGateSync({
      id: "npm-version",
      executable: "npm.cmd",
      args: ["--version"],
      cwd: process.cwd(),
      timeoutMs: 5000,
      maximumOutputBytes: 1024
    });

    assert.equal(result.exitCode, 0);
    assert.equal(result.failureClass, null);
  });

  it("resolves a bare Windows command name to its PATH shim", () => {
    if (process.platform !== "win32") return;

    const result = runQualityGateSync({
      id: "npm-bare-name",
      executable: "npm",
      args: ["--version"],
      cwd: process.cwd(),
      timeoutMs: 5000,
      maximumOutputBytes: 1024
    });

    assert.equal(result.exitCode, 0);
    assert.equal(result.failureClass, null);
  });

  it("classifies non-zero exits as deterministic failures", async () => {
    const result = await runQualityGate({
      id: "node-fail",
      executable: process.execPath,
      args: ["-e", "process.exit(7)"],
      cwd: process.cwd(),
      timeoutMs: 5000,
      maximumOutputBytes: 1024
    });

    assert.equal(result.exitCode, 7);
    assert.equal(result.failureClass, "deterministic");
  });

  it("times out long-running commands as infrastructure failures", async () => {
    const result = await runQualityGate({
      id: "node-timeout",
      executable: process.execPath,
      args: ["-e", "setTimeout(() => {}, 5000)"],
      cwd: process.cwd(),
      timeoutMs: 100,
      maximumOutputBytes: 1024
    });

    assert.equal(result.timedOut, true);
    assert.equal(result.failureClass, "infrastructure");
  });

  it("caps output and redacts secret-looking content before hashing", async () => {
    const result = await runQualityGate({
      id: "node-output",
      executable: process.execPath,
      args: ["-e", "console.log('token=abcdefghijklmnop'); console.log('x'.repeat(2000))"],
      cwd: process.cwd(),
      timeoutMs: 5000,
      maximumOutputBytes: 64
    });

    assert.equal(result.outputTruncated, true);
    assert.equal(result.redacted, true);
    assert.match(result.outputSha256, /^[a-f0-9]{64}$/);

    const redacted = redactText("apiKey=abcdefghijklmnop");
    assert.equal(redacted.text, "[REDACTED]");
    assert.equal(redacted.redacted, true);
  });
});
