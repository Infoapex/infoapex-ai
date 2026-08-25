import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";

const cliPath = resolve("dist/src/cli.js");

function runCli(repositoryPath: string, args: string[]): { status: number; stdout: string; stderr: string } {
  try {
    const stdout = execFileSync(process.execPath, [cliPath, ...args], {
      cwd: repositoryPath,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"]
    });
    return { status: 0, stdout, stderr: "" };
  } catch (error) {
    const result = error as { status?: number; stdout?: string; stderr?: string };
    return { status: result.status ?? 1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
  }
}

test("installer keeps independent mode isolated and exposes status", () => {
  const repository = mkdtempSync(join(tmpdir(), "apex-cli-independent-"));
  try {
    const init = runCli(repository, ["init", "--repo", repository, "--mode", "independent"]);
    assert.equal(init.status, 0, init.stderr);
    assert.equal(JSON.parse(init.stdout).mode, "independent");

    const status = runCli(repository, ["status", "--repo", repository]);
    const statusBody = JSON.parse(status.stdout) as { configured: boolean; config: { mode: string; planner: { enabled: boolean } } };
    assert.equal(status.status, 0);
    assert.equal(statusBody.configured, true);
    assert.equal(statusBody.config.mode, "independent");
    assert.equal(statusBody.config.planner.enabled, false);

    const payloadPath = join(repository, "payload.json");
    writeFileSync(payloadPath, JSON.stringify({ status: "DONE" }), "utf8");
    const handoff = runCli(repository, [
      "handoff", "--repo", repository, "--direction", "planner-to-worker",
      "--run-id", "independent-run", "--payload", payloadPath
    ]);
    assert.notEqual(handoff.status, 0);
    assert.match(handoff.stderr, /Integration is disabled/);
  } finally {
    rmSync(repository, { recursive: true, force: true });
  }
});

test("installer enables versioned bidirectional handoff in integrated mode", () => {
  const repository = mkdtempSync(join(tmpdir(), "apex-cli-integrated-"));
  try {
    const init = runCli(repository, ["init", "--repo", repository, "--mode", "integrated"]);
    assert.equal(init.status, 0, init.stderr);

    const payloadPath = join(repository, "payload.json");
    writeFileSync(payloadPath, JSON.stringify({ status: "DONE", taskId: "T-01" }), "utf8");
    for (const direction of ["planner-to-worker", "worker-to-planner"]) {
      const handoff = runCli(repository, [
        "handoff", "--repo", repository, "--direction", direction,
        "--run-id", "integrated-run", "--payload", payloadPath
      ]);
      assert.equal(handoff.status, 0, handoff.stderr);
      const output = JSON.parse(handoff.stdout).output as string;
      const envelope = JSON.parse(readFileSync(output, "utf8")) as {
        schemaVersion: string;
        direction: string;
        runId: string;
        payload: { status: string };
      };
      assert.equal(envelope.schemaVersion, "1.0");
      assert.equal(envelope.direction, direction);
      assert.equal(envelope.runId, "integrated-run");
      assert.equal(envelope.payload.status, "DONE");
    }
  } finally {
    rmSync(repository, { recursive: true, force: true });
  }
});

test("installer rejects an unknown mode with a structured blocked result", () => {
  const repository = mkdtempSync(join(tmpdir(), "apex-cli-invalid-"));
  try {
    const result = runCli(repository, ["init", "--repo", repository, "--mode", "unknown"]);
    assert.notEqual(result.status, 0);
    assert.equal(JSON.parse(result.stderr).status, "BLOCKED");
  } finally {
    rmSync(repository, { recursive: true, force: true });
  }
});
