import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { sha256CanonicalJson } from "../src/canonical-json.js";
import { ExecutionTimeoutError, scheduleBounded, withTimeout } from "../src/execution/scheduler.js";
import { captureWorkspaceDiff, cleanupWorkspace, prepareWorkspace, preserveWorkspaceForEvaluation, renameWorkspaceWithRetry } from "../src/isolation/workspace.js";
import { readEvents } from "../src/persistence/store.js";
import { createObservationMatrix, resumeExperiment, runExperiment, type ObservationExecutor } from "../src/runtime/index.js";

function frozenExperiment(id = "exp-runtime", repetitions = 1): Record<string, unknown> {
  const snapshot = {
    schemaVersion: "1.0", id, suiteId: "suite-runtime", suiteHash: "a".repeat(64), taskHashes: { "task-alpha": "b".repeat(64), "task-beta": "c".repeat(64) },
    environment: { schemaVersion: "1.0", id: "test-environment", os: "test", architecture: "x64", toolchain: { node: "v22" }, hardware: null, cliVersions: {}, modulePins: {}, redactedConfiguration: {} },
    arms: [
      { id: "arm-alpha", kind: "direct", provider: "fake", model: null, effort: null },
      { id: "arm-beta", kind: "full-icm", provider: "fake", model: null, effort: null },
      { id: "arm-gamma", kind: "candidate", provider: "fake", model: null, effort: null }
    ], repetitions, status: "FROZEN"
  };
  return { ...snapshot, experimentHash: sha256CanonicalJson(snapshot) };
}

function fixture(): { root: string; repository: string; state: string } {
  const root = mkdtempSync(join(tmpdir(), "bench-runtime-"));
  const repository = join(root, "repository"); const state = join(root, "state");
  mkdirSync(repository); mkdirSync(state); writeFileSync(join(repository, "baseline.txt"), "clean\n");
  return { root, repository, state };
}

test("matrix IDs, seeds, ordering, and Latin arm balance are deterministic", () => {
  const experiment = frozenExperiment("exp-matrix", 3);
  const first = createObservationMatrix(experiment); const second = createObservationMatrix(experiment);
  assert.deepEqual(first, second);
  assert.equal(new Set(first.observations.map((item) => item.id)).size, first.observations.length);
  assert.deepEqual(first.observations.map((item) => item.order), [...first.observations.keys()]);
  for (const taskId of ["task-alpha", "task-beta"]) {
    const firstPositions = first.observations.filter((item) => item.taskId === taskId).filter((_item, index) => index % 3 === 0).map((item) => item.armId);
    assert.equal(new Set(firstPositions).size, 3);
  }
});

test("scheduler preserves deterministic result order and never exceeds its bound", async () => {
  let active = 0; let maximum = 0;
  const result = await scheduleBounded([0, 1, 2, 3, 4], async (item) => {
    active += 1; maximum = Math.max(maximum, active);
    await new Promise((resolve) => setTimeout(resolve, (5 - item) * 2));
    active -= 1; return `result-${item}`;
  }, { concurrency: 2 });
  assert.equal(maximum, 2);
  assert.deepEqual(result, ["result-0", "result-1", "result-2", "result-3", "result-4"]);
});

test("evaluator workspace preservation retries only transient Windows lock errors", () => {
  let calls = 0;
  const waits: number[] = [];
  renameWorkspaceWithRetry("source", "destination", {
    rename: () => {
      calls += 1;
      if (calls < 3) throw Object.assign(new Error("temporarily locked"), { code: "EBUSY" });
    },
    wait: (milliseconds) => waits.push(milliseconds),
    attempts: 3
  });
  assert.equal(calls, 3);
  assert.deepEqual(waits, [250, 250]);
  assert.throws(() => renameWorkspaceWithRetry("source", "destination", {
    rename: () => { throw Object.assign(new Error("invalid target"), { code: "EINVAL" }); },
    wait: () => { throw new Error("must not wait"); }
  }), /invalid target/);
});

test("an identical evidence copy is a recoverable preservation checkpoint", () => {
  const root = mkdtempSync(join(tmpdir(), "bench-evidence-copy-"));
  const source = join(root, "source");
  const evidence = join(root, "evidence");
  try {
    mkdirSync(source); mkdirSync(evidence);
    writeFileSync(join(source, "result.txt"), "same\n");
    writeFileSync(join(evidence, "result.txt"), "same\n");
    assert.doesNotThrow(() => preserveWorkspaceForEvaluation(source, evidence));
    writeFileSync(join(evidence, "result.txt"), "different\n");
    assert.throws(() => preserveWorkspaceForEvaluation(source, evidence), /not identical/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("isolated observations do not share arm artifacts and cleanup removes only workspaces", async () => {
  const paths = fixture();
  try {
    const seen = new Set<string>();
    const executor: ObservationExecutor = { execute: async ({ observation, workspacePath }) => {
      assert.equal(readFileSync(join(workspacePath, "baseline.txt"), "utf8"), "clean\n");
      assert.equal(existsSync(join(workspacePath, "arm-marker.txt")), false);
      writeFileSync(join(workspacePath, "arm-marker.txt"), observation.armId);
      assert.equal(seen.has(workspacePath), false); seen.add(workspacePath);
      return { status: "DONE" };
    } };
    const result = await runExperiment({ experiment: frozenExperiment(), repositoryPath: paths.repository, stateRoot: paths.state, executor, concurrency: 3 });
    assert.equal(result.status, "READY_FOR_EVALUATION"); assert.equal(result.terminal, 6); assert.equal(seen.size, 6);
    const experimentRoot = join(paths.state, "benchmarks", "exp-runtime");
    assert.equal(existsSync(join(experimentRoot, "COMPLETE.json")), false);
    assert.deepEqual(readdirSync(join(experimentRoot, "workspaces")), []);
  } finally { rmSync(paths.root, { recursive: true, force: true }); }
});

test("maximumNewObservations supports bounded canaries and resumable batches", async () => {
  const paths = fixture(); let executions = 0;
  const executor: ObservationExecutor = { execute: async () => { executions += 1; return { status: "DONE" }; } };
  try {
    const first = await runExperiment({ experiment: frozenExperiment("exp-batches"), repositoryPath: paths.repository, stateRoot: paths.state, executor, maximumNewObservations: 3 });
    assert.equal(first.status, "INTERRUPTED"); assert.equal(first.terminal, 3); assert.equal(first.skipped, 0);
    const second = await resumeExperiment({ experimentId: "exp-batches", stateRoot: paths.state, executor, maximumNewObservations: 3 });
    assert.equal(second.status, "READY_FOR_EVALUATION"); assert.equal(second.terminal, 6); assert.equal(second.skipped, 3); assert.equal(executions, 6);
    const again = await resumeExperiment({ experimentId: "exp-batches", stateRoot: paths.state, executor, maximumNewObservations: 3 });
    assert.equal(again.skipped, 6); assert.equal(executions, 6);
    assert.equal(new Set(readEvents(join(paths.state, "benchmarks", "exp-batches", "events.jsonl")).map((event) => event.id)).size, readEvents(join(paths.state, "benchmarks", "exp-batches", "events.jsonl")).length);
    await assert.rejects(runExperiment({ experiment: frozenExperiment("exp-invalid-batch"), repositoryPath: paths.repository, stateRoot: paths.state, maximumNewObservations: 0 }), /positive safe integer/);
  } finally { rmSync(paths.root, { recursive: true, force: true }); }
});

test("resume after execution handoff does not execute or append terminal events twice", async () => {
  const paths = fixture(); let executions = 0; let injected = false;
  const executor: ObservationExecutor = { execute: async () => { executions += 1; return { status: "DONE" }; } };
  try {
    await assert.rejects(runExperiment({ experiment: frozenExperiment("exp-recovery"), repositoryPath: paths.repository, stateRoot: paths.state, executor, faultInjector: (point) => {
      if (point === "after-execution" && !injected) { injected = true; throw new Error("simulated kill"); }
    } }), /simulated kill/);
    const resumed = await resumeExperiment({ experimentId: "exp-recovery", stateRoot: paths.state, executor });
    assert.equal(resumed.status, "READY_FOR_EVALUATION"); assert.equal(executions, resumed.total);
    const eventPath = join(paths.state, "benchmarks", "exp-recovery", "events.jsonl");
    const events = readEvents(eventPath); assert.equal(new Set(events.map((event) => event.id)).size, events.length);
    const terminalCount = events.filter((event) => event.type === "observation.completed" || event.type === "observation.blocked").length;
    assert.equal(terminalCount, 0);
    const again = await resumeExperiment({ experimentId: "exp-recovery", stateRoot: paths.state, executor });
    assert.equal(again.skipped, again.total); assert.equal(executions, resumed.total);
  } finally { rmSync(paths.root, { recursive: true, force: true }); }
});

test("preparation and evaluation-handoff kill points resume idempotently", async () => {
  for (const point of ["after-preparation", "after-evaluation-handoff"] as const) {
    const paths = fixture(); let injected = false;
    try {
      const id = point === "after-preparation" ? "exp-kill-prepare" : "exp-kill-handoff";
      await assert.rejects(runExperiment({ experiment: frozenExperiment(id), repositoryPath: paths.repository, stateRoot: paths.state, faultInjector: (current) => {
        if (current === point && !injected) { injected = true; throw new Error(`kill at ${point}`); }
      } }), /kill at/);
      const result = await resumeExperiment({ experimentId: id, stateRoot: paths.state });
      assert.equal(result.status, "READY_FOR_EVALUATION"); assert.equal(result.terminal, result.total);
      const events = readEvents(join(paths.state, "benchmarks", id, "events.jsonl"));
      assert.equal(new Set(events.map((event) => event.id)).size, events.length);
      assert.equal(events.filter((event) => event.type === "observation.completed").length, 0);
    } finally { rmSync(paths.root, { recursive: true, force: true }); }
  }
});

test("resume tolerates only a truncated event tail and recovers cleanup checkpoints", async () => {
  const paths = fixture(); let injected = false;
  try {
    await assert.rejects(runExperiment({ experiment: frozenExperiment("exp-tail"), repositoryPath: paths.repository, stateRoot: paths.state, faultInjector: (point) => {
      if (point === "after-cleanup" && !injected) { injected = true; throw new Error("killed after cleanup"); }
    } }), /killed after cleanup/);
    const eventPath = join(paths.state, "benchmarks", "exp-tail", "events.jsonl");
    writeFileSync(eventPath, "{\"truncated\"", { flag: "a" });
    const result = await resumeExperiment({ experimentId: "exp-tail", stateRoot: paths.state });
    assert.equal(result.status, "READY_FOR_EVALUATION"); readEvents(eventPath);
    writeFileSync(eventPath, "not-json\n", { flag: "a" });
    assert.throws(() => readEvents(eventPath), /Invalid event log/);
  } finally { rmSync(paths.root, { recursive: true, force: true }); }
});

test("timeout and cancellation become bounded terminal or resumable states", async () => {
  const timeoutPaths = fixture();
  try {
    const hanging: ObservationExecutor = { execute: ({ signal }) => new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true })) };
    const timed = await runExperiment({ experiment: frozenExperiment("exp-timeout"), repositoryPath: timeoutPaths.repository, stateRoot: timeoutPaths.state, executor: hanging, timeoutMs: 10 });
    assert.equal(timed.status, "READY_FOR_EVALUATION"); assert.ok(timed.observations.every((entry) => entry.status === "TIMEOUT"));
  } finally { rmSync(timeoutPaths.root, { recursive: true, force: true }); }
  const cancelPaths = fixture(); const controller = new AbortController(); controller.abort(new Error("cancelled"));
  try {
    const cancelled = await runExperiment({ experiment: frozenExperiment("exp-cancel"), repositoryPath: cancelPaths.repository, stateRoot: cancelPaths.state, signal: controller.signal });
    assert.equal(cancelled.status, "INTERRUPTED"); assert.equal(cancelled.terminal, 0);
    const resumed = await resumeExperiment({ experimentId: "exp-cancel", stateRoot: cancelPaths.state }); assert.equal(resumed.status, "READY_FOR_EVALUATION");
  } finally { rmSync(cancelPaths.root, { recursive: true, force: true }); }
});

test("timeout waits for the bounded adapter cleanup path before returning", async () => {
  let cleanupFinished = false;
  const started = Date.now();
  await assert.rejects(withTimeout(async () => {
    await new Promise((resolve) => setTimeout(resolve, 25));
    cleanupFinished = true;
    return "late";
  }, 5), ExecutionTimeoutError);
  assert.equal(cleanupFinished, true);
  assert.ok(Date.now() - started >= 20);
});

test("path escapes, source symlinks, and forged cleanup records fail closed", async () => {
  const paths = fixture();
  try {
    const nestedState = join(paths.repository, "state");
    await assert.rejects(runExperiment({ experiment: frozenExperiment("exp-contained"), repositoryPath: paths.repository, stateRoot: nestedState }), /outside and separate/);
    rmSync(nestedState, { recursive: true, force: true });
    const outside = join(paths.root, "outside.txt"); writeFileSync(outside, "secret");
    let symlinksAvailable = true;
    try { symlinkSync(outside, join(paths.repository, "escape-link"), "file"); } catch { symlinksAvailable = false; }
    if (symlinksAvailable) await assert.rejects(runExperiment({ experiment: frozenExperiment("exp-symlink"), repositoryPath: paths.repository, stateRoot: paths.state }), /symlink|junction/i);
    rmSync(join(paths.repository, "escape-link"), { force: true });
    const workspaces = join(paths.state, "workspace-test"); const records = join(paths.state, "records-test"); mkdirSync(workspaces); mkdirSync(records);
    const record = prepareWorkspace(paths.repository, workspaces, records, "obs-safe", "d".repeat(64));
    const forged = join(records, "forged.json"); writeFileSync(forged, JSON.stringify({ ...record, observationId: "obs-forged", canonicalPath: paths.repository }));
    assert.throws(() => cleanupWorkspace(workspaces, forged, "obs-forged", "d".repeat(64)), /unexpected canonical path/);
    assert.equal(existsSync(join(paths.repository, "baseline.txt")), true);
    cleanupWorkspace(workspaces, join(records, "obs-safe.json"), "obs-safe", "d".repeat(64));
  } finally { rmSync(paths.root, { recursive: true, force: true }); }
});

test("safe-copy excludes generated Infoapex state before a provider worktree is created", () => {
  const paths = fixture();
  try {
    const generated = join(paths.repository, ".infoapex-ai", "runs", "deep");
    mkdirSync(generated, { recursive: true });
    writeFileSync(join(generated, "generated-evidence.json"), "private generated state\n");
    const workspaces = join(paths.state, "workspace-generated-test");
    const records = join(paths.state, "records-generated-test");
    mkdirSync(workspaces); mkdirSync(records);

    prepareWorkspace(paths.repository, workspaces, records, "obs-generated", "e".repeat(64));

    assert.equal(existsSync(join(workspaces, "obs-generated", ".infoapex-ai")), false);
    assert.equal(readFileSync(join(workspaces, "obs-generated", "baseline.txt"), "utf8"), "clean\n");
  } finally { rmSync(paths.root, { recursive: true, force: true }); }
});

test("workspace diffs exclude harness-owned ai-code-control indexes", () => {
  const paths = fixture();
  try {
    const workspaces = join(paths.state, "workspace-control-test");
    const records = join(paths.state, "records-control-test");
    prepareWorkspace(paths.repository, workspaces, records, "obs-control", "f".repeat(64));
    const workspace = join(workspaces, "obs-control");
    const db = join(workspace, ".ai-code-control", "db");
    mkdirSync(db, { recursive: true });
    writeFileSync(join(db, "memory.sqlite"), "harness-owned\n");
    const diff = captureWorkspaceDiff(paths.repository, workspace);
    assert.equal(diff.valid, true);
    assert.deepEqual(diff.changedPaths, []);
  } finally { rmSync(paths.root, { recursive: true, force: true }); }
});

test("CLI exposes deterministic run/resume and keeps live execution gated", () => {
  const paths = fixture();
  try {
    const experimentPath = join(paths.root, "experiment.json"); writeFileSync(experimentPath, JSON.stringify(frozenExperiment("exp-cli")));
    const cli = fileURLToPath(new URL("../src/cli.js", import.meta.url));
    const run = spawnSync(process.execPath, [cli, "run", "--experiment", experimentPath, "--mode", "deterministic", "--repo", paths.repository, "--state-root", paths.state], { encoding: "utf8" });
    assert.equal(run.status, 0, run.stderr); assert.equal((JSON.parse(run.stdout) as { status: string }).status, "DONE");
    const resume = spawnSync(process.execPath, [cli, "resume", "--experiment-id", "exp-cli", "--state-root", paths.state], { encoding: "utf8" });
    assert.equal(resume.status, 0, resume.stderr); assert.equal(((JSON.parse(resume.stdout) as { details: { skipped: number; total: number } }).details).skipped, 6);
    const live = spawnSync(process.execPath, [cli, "run", "--live", "--experiment", experimentPath, "--repo", paths.repository, "--state-root", paths.state], { encoding: "utf8" });
    assert.equal(live.status, 3); assert.equal((JSON.parse(live.stdout) as { status: string }).status, "UNSUPPORTED");
  } finally { rmSync(paths.root, { recursive: true, force: true }); }
});
