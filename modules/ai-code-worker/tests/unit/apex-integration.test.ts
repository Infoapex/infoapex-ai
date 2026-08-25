import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { publishWorkerFeedback, readApexIntegrationConfig } from "../../src/integration/apex-handoff.js";

test("publishes worker feedback only when apex integration is explicitly enabled", () => {
  const repo = mkdtempSync(join(tmpdir(), "aicw-apex-"));
  writeFileSync(join(repo, ".infoapex-ai-config-placeholder"), "", "utf8");
  assert.equal(publishWorkerFeedback(repo, { runId: "run-1", status: "DONE", executedTasks: [], findings: [] }), null);
});

test("publishes versioned worker-to-planner feedback in the configured handoff root", () => {
  const repo = mkdtempSync(join(tmpdir(), "aicw-apex-"));
  const apex = join(repo, ".infoapex-ai");
  requireFsWrite(join(apex, "config.json"), {
    schemaVersion: "1.0",
    mode: "integrated",
    handoffRoot: ".infoapex-ai/runs",
    worker: { enabled: true }
  });
  const output = publishWorkerFeedback(repo, {
    runId: "run-2",
    status: "BLOCKED",
    executedTasks: ["TASK-1"],
    findings: [{ code: "ENGINE_TASK_FAILED" }],
    routing: [{ id: "TASK-1", executionProfile: "balanced-default-v1" }]
  });
  assert.ok(output && existsSync(output));
  const document = JSON.parse(readFileSync(output!, "utf8"));
  assert.equal(document.direction, "worker-to-planner");
  assert.equal(document.payload.status, "BLOCKED");
  assert.equal(readApexIntegrationConfig(repo)?.mode, "integrated");
});

function requireFsWrite(path: string, value: unknown): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value)}\n`, "utf8");
}
