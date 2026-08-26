import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import {
  findPlannerHandoffRunId,
  publishWorkerFeedback,
  readApexIntegrationConfig
} from "../../src/integration/apex-handoff.js";
import { resolveHandoffFileForRead } from "../../src/integration/handoff-paths.js";

const tempRoots: string[] = [];

after(() => {
  for (const root of tempRoots) rmSync(root, { recursive: true, force: true });
});

test("publishes worker feedback only when apex integration is explicitly enabled", () => {
  const repo = temporaryRoot("aicw-apex-");
  writeFileSync(join(repo, ".infoapex-ai-config-placeholder"), "", "utf8");
  assert.equal(publishWorkerFeedback(repo, { runId: "run-1", status: "DONE", executedTasks: [], findings: [] }), null);
});

test("publishes versioned worker-to-planner feedback in the configured handoff root", () => {
  const repo = temporaryRoot("aicw-apex-");
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

test("rejects traversal and non-portable worker run identifiers before filesystem publication", () => {
  const repo = integratedRepository();
  const input = { status: "DONE", executedTasks: [], findings: [] };

  assert.throws(() => publishWorkerFeedback(repo, { ...input, runId: "../escape" }), /Invalid runId/);
  assert.throws(() => publishWorkerFeedback(repo, { ...input, runId: "run." }), /Invalid runId/);
  assert.throws(() => publishWorkerFeedback(repo, { ...input, runId: "CON" }), /Invalid runId/);
  assert.equal(existsSync(join(repo, "escape")), false);
});

test("rejects traversal, absolute, and symlinked integration roots", () => {
  const traversalRepo = temporaryRoot("aicw-apex-root-");
  writeIntegrationConfig(traversalRepo, "../outside");
  assert.throws(() => readApexIntegrationConfig(traversalRepo), /Invalid handoffRoot/);

  const absoluteRepo = temporaryRoot("aicw-apex-root-");
  writeIntegrationConfig(absoluteRepo, temporaryRoot("aicw-apex-outside-"));
  assert.throws(() => readApexIntegrationConfig(absoluteRepo), /Invalid handoffRoot/);

  const linkedRepo = temporaryRoot("aicw-apex-root-");
  const outside = temporaryRoot("aicw-apex-config-outside-");
  requireFsWrite(join(outside, "config.json"), integrationConfig(".infoapex-ai/runs"));
  symlinkSync(outside, join(linkedRepo, ".infoapex-ai"), "junction");
  assert.throws(() => readApexIntegrationConfig(linkedRepo), /escapes the repository|resolves outside/);
});

test("publishes feedback create-new and never replaces an existing handoff", () => {
  const repo = integratedRepository();
  const first = publishWorkerFeedback(repo, {
    runId: "immutable-run",
    status: "BLOCKED",
    executedTasks: [],
    findings: [{ code: "FIRST" }]
  });
  const original = readFileSync(first!, "utf8");

  assert.throws(() =>
    publishWorkerFeedback(repo, {
      runId: "immutable-run",
      status: "DONE",
      executedTasks: ["TASK-1"],
      findings: []
    })
  );
  assert.equal(readFileSync(first!, "utf8"), original);
  assert.deepEqual(
    readdirSync(join(repo, ".infoapex-ai", "runs", "immutable-run")).filter((name) => name.endsWith(".tmp")),
    []
  );
});

test("skips malformed planner candidates and accepts only a matching validated envelope", () => {
  const repo = integratedRepository();
  requireFsWrite(join(repo, ".infoapex-ai", "runs", "wrong-run", "planner-to-worker.json"), {
    schemaVersion: "1.0",
    handoffId: "handoff-wrong",
    direction: "planner-to-worker",
    createdAt: "2026-08-26T09:00:00.000Z",
    runId: "different-run",
    payload: { planPath: "Plan/RUN.md" }
  });
  requireFsWrite(join(repo, ".infoapex-ai", "runs", "valid-run", "planner-to-worker.json"), {
    schemaVersion: "1.0",
    handoffId: "handoff-valid",
    direction: "planner-to-worker",
    createdAt: "2026-08-26T09:00:00.000Z",
    runId: "valid-run",
    payload: { planPath: "Plan/RUN.md" }
  });

  assert.equal(findPlannerHandoffRunId(repo, "Plan/RUN.md"), "valid-run");
});

test("fails closed when a candidate run directory resolves outside handoffRoot", () => {
  const repo = integratedRepository();
  const root = join(repo, ".infoapex-ai", "runs");
  const outside = temporaryRoot("aicw-apex-run-outside-");
  mkdirSync(root, { recursive: true });
  symlinkSync(outside, join(root, "linked-run"), "junction");

  assert.throws(
    () => resolveHandoffFileForRead(repo, ".infoapex-ai/runs", "linked-run", "planner-to-worker.json"),
    /escapes handoffRoot|resolves outside/
  );
});

function requireFsWrite(path: string, value: unknown): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value)}\n`, "utf8");
}

function temporaryRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  tempRoots.push(root);
  return root;
}

function integratedRepository(): string {
  const repo = temporaryRoot("aicw-apex-");
  writeIntegrationConfig(repo, ".infoapex-ai/runs");
  return repo;
}

function writeIntegrationConfig(repo: string, handoffRoot: string): void {
  requireFsWrite(join(repo, ".infoapex-ai", "config.json"), integrationConfig(handoffRoot));
}

function integrationConfig(handoffRoot: string): unknown {
  return {
    schemaVersion: "1.0",
    mode: "integrated",
    handoffRoot,
    worker: { enabled: true }
  };
}
