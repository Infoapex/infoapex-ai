import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import {
  exportBranch,
  exportPatch,
  ExportBranchError,
  writeBlockedReport,
  writePatchFile,
  writeRedactedHandoff,
  writeRepairEvidenceReport
} from "../../src/report/export-artifacts.js";
import { git } from "../../src/git/diff.js";
import type { RepairAttempt } from "../../src/repair/repair-attempt.js";
import type { RepairBudget } from "../../src/repair/repair-budget.js";
import type { RepairTask } from "../../src/repair/repair-task.js";

const tempDirs: string[] = [];

after(() => {
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function createRepoWithTwoCommits(): { readonly repo: string; readonly baseCommit: string; readonly headCommit: string } {
  const repo = mktemp("aicw-export-");
  execFileSync("git", ["init"], { cwd: repo, stdio: "ignore" });
  writeFileSync(join(repo, "file.txt"), "original\n", "utf8");
  execFileSync("git", ["add", "file.txt"], { cwd: repo, stdio: "ignore" });
  commit(repo, "base commit");
  const baseCommit = git(["rev-parse", "HEAD"], repo);

  writeFileSync(join(repo, "file.txt"), "original\nchanged\n", "utf8");
  execFileSync("git", ["add", "file.txt"], { cwd: repo, stdio: "ignore" });
  commit(repo, "head commit");
  const headCommit = git(["rev-parse", "HEAD"], repo);

  return { repo, baseCommit, headCommit };
}

function commit(repo: string, message: string): void {
  execFileSync("git", ["-c", "user.name=ai-code-worker", "-c", "user.email=worker@example.test", "commit", "-m", message], {
    cwd: repo,
    env: { ...process.env, GIT_AUTHOR_DATE: "2026-08-01T10:00:00Z", GIT_COMMITTER_DATE: "2026-08-01T10:00:00Z" },
    stdio: "ignore"
  });
}

function mktemp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

describe("export patch", () => {
  it("produces an appliable diff between the base and head commits", () => {
    const { repo, baseCommit, headCommit } = createRepoWithTwoCommits();

    const patch = exportPatch({ repositoryPath: repo, baseCommit, headCommit });

    assert.match(patch.patchText, /file\.txt/);
    assert.match(patch.patchText, /\+changed/);
    assert.equal(patch.baseCommit, baseCommit);
    assert.equal(patch.headCommit, headCommit);
    assert.match(patch.sha256, /^[a-f0-9]{64}$/);
  });

  it("writes the patch under <runRoot>/export/patch.diff", () => {
    const { repo, baseCommit, headCommit } = createRepoWithTwoCommits();
    const runRoot = mktemp("aicw-export-run-");
    const patch = exportPatch({ repositoryPath: repo, baseCommit, headCommit });

    const path = writePatchFile(runRoot, patch);

    assert.equal(path, join(runRoot, "export", "patch.diff"));
    assert.equal(readFileSync(path, "utf8"), patch.patchText.endsWith("\n") ? patch.patchText : `${patch.patchText}\n`);
  });
});

describe("export branch", () => {
  it("creates a new branch pointing at the given commit without touching the checked-out branch", () => {
    const { repo, headCommit } = createRepoWithTwoCommits();
    const currentBranch = git(["rev-parse", "--abbrev-ref", "HEAD"], repo);

    const result = exportBranch({ repositoryPath: repo, branchName: "aiw/export/run-x", headCommit });

    assert.equal(result.branchName, "aiw/export/run-x");
    assert.equal(result.commit, headCommit);
    assert.equal(git(["rev-parse", "aiw/export/run-x"], repo), headCommit);
    assert.equal(git(["rev-parse", "--abbrev-ref", "HEAD"], repo), currentBranch);
  });

  it("refuses to move the currently checked-out branch", () => {
    const { repo, headCommit } = createRepoWithTwoCommits();
    const currentBranch = git(["rev-parse", "--abbrev-ref", "HEAD"], repo);

    assert.throws(
      () => exportBranch({ repositoryPath: repo, branchName: currentBranch, headCommit }),
      (error: unknown) => error instanceof ExportBranchError && error.code === "BRANCH_IS_CHECKED_OUT"
    );
  });
});

describe("blocked report", () => {
  it("writes BLOCKED.md with cause, last safe state, evidence, and resume instructions", () => {
    const runRoot = mktemp("aicw-blocked-");

    const result = writeBlockedReport({
      runRoot,
      runId: "run-blocked-1",
      cause: "Repeated failure without progress on REV-001.",
      lastSafeState: "Cycle 2 of 3, all tasks up to CONTRACT-01 remain PASSED.",
      evidencePaths: ["repairs/repair-evidence.md", "tasks/CONTRACT-01/evidence.json"],
      resumeInstructions: "Fix REV-001 manually, then re-run with `--run-id run-blocked-1`."
    });

    assert.equal(result.path, join(runRoot, "BLOCKED.md"));
    assert.equal(result.redacted, false);
    assert.equal(result.truncated, false);
    const content = readFileSync(result.path, "utf8");
    assert.match(content, /## Cause\n\nRepeated failure without progress on REV-001\./);
    assert.match(content, /## Last Safe State/);
    assert.match(content, /## Evidence/);
    assert.match(content, /- repairs\/repair-evidence\.md/);
    assert.match(content, /## Resume Instructions/);
  });
});

describe("redacted handoff export", () => {
  it("writes to the canonical .ai-code-control/handoffs/<runId>.md location", () => {
    const repo = mktemp("aicw-handoff-");

    const result = writeRedactedHandoff({
      repositoryPath: repo,
      runId: "run-handoff-1",
      status: "DONE",
      executedTasks: ["CONTRACT-01", "BACKEND-01"],
      findings: [],
      usageTotals: { inputUncachedTokens: 120, outputTokens: 40 },
      contextProviderKind: "ai-code-control"
    });

    assert.equal(result.path, join(repo, ".ai-code-control", "handoffs", "run-handoff-1.md"));
    assert.equal(result.redacted, false);
    const content = readFileSync(result.path, "utf8");
    assert.match(content, /- Run ID: run-handoff-1/);
    assert.match(content, /- Status: DONE/);
    assert.match(content, /- Context provider: ai-code-control/);
    assert.match(content, /CONTRACT-01, BACKEND-01/);
    assert.match(content, /- inputUncachedTokens: 120/);
  });

  it("redacts secret-looking finding messages before writing", () => {
    const repo = mktemp("aicw-handoff-");

    const result = writeRedactedHandoff({
      repositoryPath: repo,
      runId: "run-handoff-2",
      status: "BLOCKED",
      executedTasks: [],
      findings: [{ severity: "blocker", code: "GATE_FAILED", message: 'api_key: "sk-abcdefghijklmnop" leaked in test output' }],
      usageTotals: null,
      contextProviderKind: "ai-code-control"
    });

    assert.equal(result.redacted, true);
    const content = readFileSync(result.path, "utf8");
    assert.doesNotMatch(content, /sk-abcdefghijklmnop/);
    assert.match(content, /\[REDACTED\]/);
  });
});

describe("repair evidence report", () => {
  it("summarizes repair budget consumption and attempts", () => {
    const runRoot = mktemp("aicw-repair-evidence-");
    const task: RepairTask = {
      schemaVersion: "1.0",
      id: "REPAIR-001",
      runId: "run-repair-evidence",
      graphVersion: 2,
      sourceFindingIds: ["REV-001"],
      allowedPaths: ["backend/Auth/**"],
      forbiddenPaths: [],
      verify: ["backend-tests"],
      dependsOn: [],
      maximumAttempts: 3,
      status: "BLOCKED",
      createdAt: "2026-08-14T12:00:00Z"
    };
    const attempts: readonly RepairAttempt[] = [
      {
        schemaVersion: "1.0",
        id: "REPAIR-001-cycle-1",
        repairTaskId: "REPAIR-001",
        runId: "run-repair-evidence",
        cycle: 1,
        startedAt: "2026-08-14T12:00:00Z",
        finishedAt: "2026-08-14T12:05:00Z",
        outcome: "FAILED",
        commit: null,
        failureSignatureId: null,
        evidenceRef: null
      }
    ];
    const budget: RepairBudget = {
      schemaVersion: "1.0",
      runId: "run-repair-evidence",
      maximumRepairCycles: 3,
      consumedCycles: 1,
      remainingCycles: 2,
      stopReason: "repeated-failure-no-progress",
      updatedAt: "2026-08-14T12:05:00Z"
    };

    const path = writeRepairEvidenceReport({ runRoot, runId: "run-repair-evidence", budget, tasks: [task], attempts });

    assert.equal(path, join(runRoot, "repairs", "repair-evidence.md"));
    assert.equal(existsSync(path), true);
    const content = readFileSync(path, "utf8");
    assert.match(content, /Repair cycles consumed: 1 \/ 3/);
    assert.match(content, /Stop reason: repeated-failure-no-progress/);
    assert.match(content, /cycle 1, task REPAIR-001 \(scope: backend\/Auth\/\*\*\): FAILED/);
  });
});
