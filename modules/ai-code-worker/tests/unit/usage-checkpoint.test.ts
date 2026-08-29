import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { resolveUsageCheckpointLogPath, UsageCheckpointLog } from "../../src/benchmark/usage-checkpoint.js";

const tempRoots: string[] = [];

after(() => {
  for (const root of tempRoots) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("usage checkpoint log", () => {
  it("appends schema-valid checkpoints and reads them back in order", () => {
    const root = mkdtempSync(join(tmpdir(), "aicw-usage-checkpoints-"));
    tempRoots.push(root);
    const log = new UsageCheckpointLog(join(root, "usage-checkpoints.jsonl"));

    log.append({
      checkpointId: "run-1-task-a-start",
      runId: "run-1",
      taskId: "TASK-A",
      scope: "task",
      engine: "claude",
      phase: "start",
      createdAt: "2026-08-15T10:00:00Z",
      taskKind: "backend",
      taskRisk: "medium"
    });
    log.append({
      checkpointId: "run-1-task-a-end",
      runId: "run-1",
      taskId: "TASK-A",
      scope: "task",
      engine: "claude",
      phase: "end",
      createdAt: "2026-08-15T10:01:00Z",
      taskKind: "backend",
      taskRisk: "medium",
      tokens: { inputUncachedTokens: 100, cacheReadTokens: 500, cacheWriteTokens: 20, outputTokens: 300, costUsd: 0.01 }
    });

    const { checkpoints, ignoredTailLines } = log.read();

    assert.equal(checkpoints.length, 2);
    assert.equal(ignoredTailLines.length, 0);
    assert.equal(checkpoints[0]?.phase, "start");
    assert.equal(checkpoints[0]?.schemaVersion, "1.1");
    assert.deepEqual(checkpoints[0]?.tokens, {
      inputUncachedTokens: null,
      cacheReadTokens: null,
      cacheWriteTokens: null,
      outputTokens: null,
      costUsd: null
    });
    assert.equal(checkpoints[1]?.phase, "end");
    assert.equal(checkpoints[1]?.tokens.outputTokens, 300);
    assert.equal(checkpoints[1]?.taskKind, "backend");
    assert.equal(checkpoints[1]?.taskRisk, "medium");
  });

  it("persists a profiled v1.1 checkpoint while continuing to read legacy v1.0 lines", () => {
    const root = mkdtempSync(join(tmpdir(), "aicw-usage-checkpoints-versioned-"));
    tempRoots.push(root);
    const path = join(root, "usage-checkpoints.jsonl");
    const log = new UsageCheckpointLog(path);
    const legacy = {
      schemaVersion: "1.0",
      checkpointId: "legacy",
      runId: "run-legacy",
      taskId: "TASK-A",
      scope: "task",
      engine: "codex",
      phase: "end",
      createdAt: "2026-08-14T10:00:00Z",
      taskKind: "backend",
      taskRisk: "medium",
      tokens: { inputUncachedTokens: 1, cacheReadTokens: 2, cacheWriteTokens: null, outputTokens: 3, costUsd: null },
      contextEstimateTokens: null,
      percentUsedReported: null,
      percentUsedEstimated: null
    };
    writeFileSync(path, `${JSON.stringify(legacy)}\n`, "utf8");

    const appended = log.append({
      checkpointId: "profiled",
      runId: "run-profiled",
      taskId: "TASK-B",
      scope: "task",
      engine: "codex",
      phase: "end",
      createdAt: "2026-08-15T10:00:00Z",
      taskKind: "backend",
      taskRisk: "high",
      model: "gpt-5.6-sol",
      reasoningEffort: "high",
      calibrationProfileId: "codex:gpt-5.6-sol:high"
    });
    const result = log.read();

    assert.equal(result.checkpoints[0]?.schemaVersion, "1.0");
    assert.equal(result.checkpoints[1]?.schemaVersion, "1.1");
    assert.equal(appended.model, "gpt-5.6-sol");
    assert.equal(appended.reasoningEffort, "high");
  });

  it("rejects an inverted prediction interval before it is appended", () => {
    const root = mkdtempSync(join(tmpdir(), "aicw-usage-checkpoints-prediction-"));
    tempRoots.push(root);
    const log = new UsageCheckpointLog(join(root, "usage-checkpoints.jsonl"));

    assert.throws(
      () =>
        log.append({
          checkpointId: "bad-prediction",
          runId: "run-1",
          scope: "development",
          engine: "codex",
          phase: "start",
          createdAt: "2026-08-15T10:00:00Z",
          prediction: { lowTokens: 20, medianTokens: 10, highTokens: 30, source: "test" }
        }),
      /lowTokens <= medianTokens <= highTokens/
    );
  });

  it("returns an empty result when the log file does not exist yet", () => {
    const root = mkdtempSync(join(tmpdir(), "aicw-usage-checkpoints-empty-"));
    tempRoots.push(root);
    const log = new UsageCheckpointLog(join(root, "does-not-exist.jsonl"));

    assert.deepEqual(log.read(), { checkpoints: [], ignoredTailLines: [] });
  });

  it("tolerates a truncated last line (process killed mid-write) but rejects a corrupt line elsewhere", () => {
    const root = mkdtempSync(join(tmpdir(), "aicw-usage-checkpoints-corrupt-"));
    tempRoots.push(root);
    const path = join(root, "usage-checkpoints.jsonl");
    const log = new UsageCheckpointLog(path);

    log.append({
      checkpointId: "run-1-task-a-start",
      runId: "run-1",
      taskId: "TASK-A",
      scope: "task",
      engine: "fake",
      phase: "start",
      createdAt: "2026-08-15T10:00:00Z"
    });
    writeFileSync(path, '{"schemaVersion":"1.0","checkpointId":"truncated', { flag: "a", encoding: "utf8" });

    const { checkpoints, ignoredTailLines } = log.read();

    assert.equal(checkpoints.length, 1);
    assert.equal(ignoredTailLines.length, 1);
  });

  it("rejects a schema-invalid checkpoint on append", () => {
    const root = mkdtempSync(join(tmpdir(), "aicw-usage-checkpoints-invalid-"));
    tempRoots.push(root);
    const log = new UsageCheckpointLog(join(root, "usage-checkpoints.jsonl"));

    assert.throws(() =>
      log.append({
        checkpointId: "bad",
        runId: "run-1",
        scope: "task",
        // @ts-expect-error - deliberately invalid engine for the schema-rejection test
        engine: "not-a-real-engine",
        phase: "start",
        createdAt: "2026-08-15T10:00:00Z"
      })
    );
  });

  it("resolves the checkpoint log path under the resolved state root's benchmarks/ directory, alongside runs/", () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "aicw-usage-checkpoints-repo-"));
    tempRoots.push(repoRoot);

    const path = resolveUsageCheckpointLogPath(repoRoot);

    assert.ok(path.endsWith(join("benchmarks", "usage-checkpoints.jsonl")));
  });
});
