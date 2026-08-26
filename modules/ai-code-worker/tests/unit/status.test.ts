import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, describe, it } from "node:test";
import { EventLog } from "../../src/persistence/event-log.js";
import { createLease, writeLease } from "../../src/persistence/lease.js";
import { runStatus } from "../../src/status/status.js";
import { resolveStateRoot } from "../../src/state/state-root.js";

const tempRepos: string[] = [];

after(() => {
  for (const repo of tempRepos) {
    rmSync(repo, { recursive: true, force: true });
  }
});

describe("status command", () => {
  it("replays events from the external state root", () => {
    const repo = createGitRepository();
    const log = eventLogFor(repo, "run-status-1");
    log.append({ eventId: "event-1", runId: "run-status-1", type: "run.created", createdAt: "2026-08-01T10:00:00Z" });
    log.append({ eventId: "event-2", runId: "run-status-1", type: "authorization.bound", createdAt: "2026-08-01T10:01:00Z" });

    const report = runStatus({
      repositoryPath: repo,
      runId: "run-status-1",
      now: "2026-08-01T10:01:10Z"
    });

    assert.equal(report.status, "PASS");
    assert.equal(report.run.status, "AUTHORIZED");
    assert.equal(report.eventLog.eventCount, 2);
    assert.equal(report.lease.state, "missing");
  });

  it("warns when an active lease exists", () => {
    const repo = createGitRepository();
    eventLogFor(repo, "run-status-2").append({
      eventId: "event-1",
      runId: "run-status-2",
      type: "run.created",
      createdAt: "2026-08-01T10:00:00Z"
    });
    const leasePath = join(runRootFor(repo, "run-status-2"), "lease.json");
    writeLease(leasePath, createLease("run-status-2", "coordinator-1", "2026-08-01T10:00:30Z"));

    const report = runStatus({
      repositoryPath: repo,
      runId: "run-status-2",
      now: "2026-08-01T10:01:00Z",
      maximumHeartbeatAgeMs: 60000
    });

    assert.equal(report.status, "WARN");
    assert.equal(report.lease.state, "active");
    assert.ok(report.findings.some((finding) => finding.code === "LEASE_ACTIVE"));
  });

  it("rejects unsafe run identifiers without resolving a state path", () => {
    const repo = createGitRepository();
    for (const runId of [".", "..", "run.", "NUL", "x".repeat(129)]) {
      const report = runStatus({ repositoryPath: repo, runId });
      assert.equal(report.status, "BLOCKED", runId);
      assert.equal(report.findings[0]?.code, "RUN_ID_INVALID", runId);
      assert.equal(report.eventLog.path, "", runId);
    }
  });

  it("exposes status as a JSON CLI command", () => {
    const repo = createGitRepository();
    eventLogFor(repo, "run-status-3").append({
      eventId: "event-1",
      runId: "run-status-3",
      type: "run.done",
      createdAt: "2026-08-01T10:00:00Z"
    });
    const output = execFileSync(
      process.execPath,
      [resolve("dist/src/cli.js"), "status", "--repo", repo, "--run-id", "run-status-3", "--json"],
      { cwd: tmpdir(), encoding: "utf8" }
    );
    const report = JSON.parse(output) as { status: string; run: { status: string } };

    assert.equal(report.status, "PASS");
    assert.equal(report.run.status, "DONE");
  });
});

function createGitRepository(): string {
  const repo = mkdtempSync(join(tmpdir(), "aicw-status-"));
  tempRepos.push(repo);

  execFileSync("git", ["init"], { cwd: repo, stdio: "ignore" });
  writeFileSync(join(repo, "README.md"), "# fixture\n");
  execFileSync("git", ["add", "README.md"], { cwd: repo, stdio: "ignore" });
  execFileSync("git", ["-c", "user.name=ai-code-worker", "-c", "user.email=worker@example.test", "commit", "-m", "init"], {
    cwd: repo,
    stdio: "ignore"
  });

  return repo;
}

function eventLogFor(repo: string, runId: string): EventLog {
  const path = join(runRootFor(repo, runId), "events.jsonl");
  mkdirSync(runRootFor(repo, runId), { recursive: true });

  return new EventLog(path);
}

function runRootFor(repo: string, runId: string): string {
  return join(resolveStateRoot({ repoRoot: repo }).path, "runs", runId);
}
