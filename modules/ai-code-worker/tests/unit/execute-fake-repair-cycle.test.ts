import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { createFakeRepairExecutor } from "../../src/repair/execute-fake-repair-cycle.js";
import { resolveStateRoot } from "../../src/state/state-root.js";
import type { IndependentReviewResult } from "../../src/review/independent-review.js";
import type { IngestedFinding } from "../../src/review/ingest-review.js";
import type { RepairTask } from "../../src/repair/repair-task.js";

const tempRepos: string[] = [];
const stateRoots: string[] = [];

after(() => {
  for (const root of stateRoots) {
    rmSync(root, { recursive: true, force: true });
  }

  for (const repo of tempRepos) {
    rmSync(repo, { recursive: true, force: true });
  }
});

function createFixtureRepository(): { repo: string; stateRoot: string; baseCommit: string } {
  const repo = mkdtempSync(join(tmpdir(), "aicw-execute-fake-repair-"));
  tempRepos.push(repo);
  const stateRoot = resolveStateRoot({ repoRoot: repo }).path;
  stateRoots.push(stateRoot);

  writeFileSync(join(repo, "README.md"), "# fixture\n", "utf8");
  execFileSync("git", ["init", "-b", "main"], { cwd: repo, stdio: "ignore" });
  execFileSync("git", ["add", "."], { cwd: repo, stdio: "ignore" });
  execFileSync("git", ["-c", "user.name=ai-code-worker", "-c", "user.email=worker@example.test", "commit", "-m", "init"], {
    cwd: repo,
    env: { ...process.env, GIT_AUTHOR_DATE: "2026-08-15T10:00:00Z", GIT_COMMITTER_DATE: "2026-08-15T10:00:00Z" },
    stdio: "ignore"
  });

  const baseCommit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim();
  return { repo, stateRoot, baseCommit };
}

function finding(overrides: Partial<IngestedFinding> = {}): IngestedFinding {
  return {
    id: "REV-001",
    severity: "blocking",
    category: "correctness",
    criterionIds: ["AC-01"],
    files: ["target.txt"],
    evidence: "target.txt is missing the required marker.",
    eligibleForRepair: true,
    ineligibilityReason: null,
    ...overrides
  };
}

function repairTask(overrides: Partial<RepairTask> = {}): RepairTask {
  return {
    schemaVersion: "1.0",
    id: "REPAIR-001",
    runId: "run-execute-fake-repair",
    graphVersion: 1,
    sourceFindingIds: ["REV-001"],
    allowedPaths: ["target.txt"],
    forbiddenPaths: [],
    verify: [],
    dependsOn: [],
    maximumAttempts: 1,
    status: "READY",
    createdAt: "2026-08-15T10:00:00Z",
    ...overrides
  };
}

function cleanReview(runId: string): IndependentReviewResult {
  return {
    schemaVersion: "1.0",
    runId,
    reviewId: "review-after-repair",
    reviewer: "test-reviewer",
    graphVersion: 1,
    createdAt: "2026-08-15T10:05:00Z",
    verdict: "pass",
    criterionCoverage: [],
    findings: []
  };
}

describe("createFakeRepairExecutor", () => {
  it("reports PASSED only when the task's own verify command actually passes against the real committed content", () => {
    const { repo, stateRoot, baseCommit } = createFixtureRepository();
    const runId = "run-execute-fake-repair-pass";

    const executor = createFakeRepairExecutor({
      repositoryPath: repo,
      stateRoot,
      runId,
      manifestSha256: "0".repeat(64),
      baseCommit,
      reviewer: () => cleanReview(runId)
    });

    const task = repairTask({ runId, verify: ["node -e \"process.exit(require('fs').readFileSync('target.txt','utf8').includes('repair task=') ? 0 : 1)\""] });
    const result = executor({ cycle: 1, tasks: [task], findings: [finding()] });

    assert.equal(result.taskOutcomes.length, 1);
    assert.equal(result.taskOutcomes[0]?.outcome, "PASSED");
    assert.ok(result.taskOutcomes[0]?.commit);
    assert.equal(result.reviewAfterCycle.verdict, "pass");

    // The commit is real: read the file back at the reported commit.
    const committedContent = execFileSync("git", ["show", `${result.taskOutcomes[0]!.commit}:target.txt`], {
      cwd: repo,
      encoding: "utf8"
    });
    assert.match(committedContent, /repair task=REPAIR-001 cycle=1/);
  });

  it("reports FAILED, not PASSED, when the task's own verify command does not pass - it does not lie about success", () => {
    const { repo, stateRoot, baseCommit } = createFixtureRepository();
    const runId = "run-execute-fake-repair-fail";

    const executor = createFakeRepairExecutor({
      repositoryPath: repo,
      stateRoot,
      runId,
      manifestSha256: "0".repeat(64),
      baseCommit,
      reviewer: () => cleanReview(runId)
    });

    // This verify command can never pass against what writeFakeRepairOutput
    // actually writes - the point of the test is that the executor must not
    // report PASSED just because a commit happened.
    const task = repairTask({ runId, verify: ["node -e \"process.exit(require('fs').readFileSync('target.txt','utf8').includes('nonexistent-marker') ? 0 : 1)\""] });
    const result = executor({ cycle: 1, tasks: [task], findings: [finding()] });

    assert.equal(result.taskOutcomes[0]?.outcome, "FAILED");
    assert.ok(result.taskOutcomes[0]?.commit, "a real commit still happens even though verify fails");
    assert.ok(result.taskOutcomes[0]?.evidenceRef && existsSync(result.taskOutcomes[0].evidenceRef));

    const evidence = JSON.parse(readFileSync(result.taskOutcomes[0]!.evidenceRef!, "utf8"));
    assert.equal(evidence.stage, "verify");
    assert.equal(evidence.verifyResults[0].exitCode, 1);
  });

  it("calls the injected reviewer with the repair commits, not a hardcoded clean result", () => {
    const { repo, stateRoot, baseCommit } = createFixtureRepository();
    const runId = "run-execute-fake-repair-reviewer";
    let reviewerCalledWith: Readonly<Record<string, string>> | null = null;

    const executor = createFakeRepairExecutor({
      repositoryPath: repo,
      stateRoot,
      runId,
      manifestSha256: "0".repeat(64),
      baseCommit,
      reviewer: (context) => {
        reviewerCalledWith = context.taskCommits;
        return cleanReview(runId);
      }
    });

    const task = repairTask({ runId, verify: ["node -e \"process.exit(0)\""] });
    const result = executor({ cycle: 1, tasks: [task], findings: [finding()] });

    assert.ok(reviewerCalledWith);
    assert.equal(reviewerCalledWith!["REPAIR-001"], result.taskOutcomes[0]?.commit);
  });

  it("returns BLOCKED, not FAILED, when the worktree cannot be created", () => {
    const { repo, stateRoot } = createFixtureRepository();
    const runId = "run-execute-fake-repair-bad-base";

    const executor = createFakeRepairExecutor({
      repositoryPath: repo,
      stateRoot,
      runId,
      manifestSha256: "0".repeat(64),
      baseCommit: "0".repeat(40),
      reviewer: () => cleanReview(runId)
    });

    const task = repairTask({ runId });
    const result = executor({ cycle: 1, tasks: [task], findings: [finding()] });

    assert.equal(result.taskOutcomes[0]?.outcome, "BLOCKED");
    assert.equal(result.taskOutcomes[0]?.commit, null);
  });
});
