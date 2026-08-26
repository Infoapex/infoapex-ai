import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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
    const initBody = JSON.parse(init.stdout) as { mode: string; configPath: string; handoffRoot: string };
    assert.equal(initBody.mode, "independent");
    assert.match(initBody.configPath, /[\\/]\.infoapex-ai[\\/]config\.json$/);
    assert.match(initBody.handoffRoot, /[\\/]\.infoapex-ai[\\/]runs$/);
    assert.equal(existsSync(join(repository, ".infoapex-ai", "README.md")), true);
    assert.match(readFileSync(join(repository, ".infoapex-ai", "README.md"), "utf8"), /infoapex-ai init/);

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

    const duplicate = runCli(repository, [
      "handoff", "--repo", repository, "--direction", "planner-to-worker",
      "--run-id", "integrated-run", "--payload", payloadPath
    ]);
    assert.notEqual(duplicate.status, 0);
    assert.match(JSON.parse(duplicate.stderr).error, /EEXIST|already exists/i);
    const preserved = JSON.parse(readFileSync(join(repository, ".infoapex-ai", "runs", "integrated-run", "planner-to-worker.json"), "utf8"));
    assert.equal(preserved.payload.taskId, "T-01");
  } finally {
    rmSync(repository, { recursive: true, force: true });
  }
});

test("handoff rejects traversal, absolute, volume-prefixed and non-portable run IDs before filesystem access", () => {
  const repository = mkdtempSync(join(tmpdir(), "apex-cli-run-id-"));
  try {
    const payloadPath = join(repository, "payload.json");
    writeFileSync(payloadPath, JSON.stringify({ status: "DONE" }), "utf8");
    const maliciousRunIds = [
      "..",
      ".",
      "../escaped",
      "..\\escaped",
      "/tmp/escaped",
      "C:\\escaped",
      "C:escaped",
      "\\\\server\\share",
      "foo.",
      "CON"
    ];

    for (const runId of maliciousRunIds) {
      const result = runCli(repository, [
        "handoff", "--repo", repository, "--direction", "planner-to-worker",
        "--run-id", runId, "--payload", payloadPath
      ]);
      assert.notEqual(result.status, 0, runId);
      assert.match(JSON.parse(result.stderr).error, /Invalid runId/, runId);
    }
    assert.equal(existsSync(join(repository, ".infoapex-ai")), false);
  } finally {
    rmSync(repository, { recursive: true, force: true });
  }
});

test("status and handoff reject invalid or escaping integration config", () => {
  const repository = mkdtempSync(join(tmpdir(), "apex-cli-config-"));
  const external = mkdtempSync(join(tmpdir(), "apex-cli-external-"));
  try {
    const configPath = join(repository, ".infoapex-ai", "config.json");
    mkdirSync(join(repository, ".infoapex-ai"), { recursive: true });
    const invalidConfigs: unknown[] = [
      { schemaVersion: "2.0", mode: "integrated", handoffRoot: ".infoapex-ai/runs" },
      { schemaVersion: "1.0", mode: "integrated", handoffRoot: "../escaped" },
      { schemaVersion: "1.0", mode: "integrated", handoffRoot: external },
      { schemaVersion: "1.0", mode: "integrated", handoffRoot: "C:\\escaped" },
      { schemaVersion: "1.0", mode: "integrated", handoffRoot: "\\\\server\\share" },
      { schemaVersion: "1.0", mode: "integrated", handoffRoot: ".infoapex-ai/runs", unexpected: true }
    ];

    for (const config of invalidConfigs) {
      writeFileSync(configPath, JSON.stringify(config), "utf8");
      const result = runCli(repository, ["status", "--repo", repository]);
      assert.notEqual(result.status, 0, JSON.stringify(config));
      assert.equal(JSON.parse(result.stderr).status, "BLOCKED");
    }
  } finally {
    rmSync(repository, { recursive: true, force: true });
    rmSync(external, { recursive: true, force: true });
  }
});

test("handoff validates payload JSON and requires an object", () => {
  const repository = mkdtempSync(join(tmpdir(), "apex-cli-payload-"));
  try {
    assert.equal(runCli(repository, ["init", "--repo", repository, "--mode", "integrated"]).status, 0);
    const payloadPath = join(repository, "payload.json");

    for (const source of ["[1,2,3]", "not-json"]) {
      writeFileSync(payloadPath, source, "utf8");
      const result = runCli(repository, [
        "handoff", "--repo", repository, "--direction", "planner-to-worker",
        "--run-id", "payload-run", "--payload", payloadPath
      ]);
      assert.notEqual(result.status, 0);
      assert.match(JSON.parse(result.stderr).error, /payload|JSON/i);
      assert.equal(existsSync(join(repository, ".infoapex-ai", "runs", "payload-run")), false);
    }
  } finally {
    rmSync(repository, { recursive: true, force: true });
  }
});

test("config reads reject an integration-root symlink or junction that escapes the repository", (context) => {
  const repository = mkdtempSync(join(tmpdir(), "apex-cli-config-link-"));
  const external = mkdtempSync(join(tmpdir(), "apex-cli-config-target-"));
  try {
    writeFileSync(join(external, "config.json"), JSON.stringify({
      schemaVersion: "1.0",
      mode: "integrated",
      handoffRoot: ".infoapex-ai/runs"
    }), "utf8");
    try {
      symlinkSync(external, join(repository, ".infoapex-ai"), process.platform === "win32" ? "junction" : "dir");
    } catch (error) {
      context.skip(`Symlink/junction creation is unavailable: ${String(error)}`);
      return;
    }

    const result = runCli(repository, ["status", "--repo", repository]);
    assert.notEqual(result.status, 0);
    assert.match(JSON.parse(result.stderr).error, /escapes|outside/i);
  } finally {
    rmSync(repository, { recursive: true, force: true });
    rmSync(external, { recursive: true, force: true });
  }
});

test("installer rejects an existing handoff-root junction that escapes the repository", (context) => {
  const repository = mkdtempSync(join(tmpdir(), "apex-cli-init-link-"));
  const external = mkdtempSync(join(tmpdir(), "apex-cli-init-target-"));
  try {
    mkdirSync(join(repository, ".infoapex-ai"), { recursive: true });
    try {
      symlinkSync(external, join(repository, ".infoapex-ai", "runs"), process.platform === "win32" ? "junction" : "dir");
    } catch (error) {
      context.skip(`Symlink/junction creation is unavailable: ${String(error)}`);
      return;
    }

    const result = runCli(repository, ["init", "--repo", repository, "--mode", "integrated"]);
    assert.notEqual(result.status, 0);
    assert.match(JSON.parse(result.stderr).error, /escapes|outside/i);
    assert.deepEqual(readdirSync(external), []);
    assert.equal(existsSync(join(repository, ".infoapex-ai", "config.json")), false);
  } finally {
    rmSync(repository, { recursive: true, force: true });
    rmSync(external, { recursive: true, force: true });
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
