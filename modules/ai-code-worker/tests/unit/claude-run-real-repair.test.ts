import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { after, describe, it } from "node:test";
import { writeFakeClaudeCli } from "../../src/engines/claude-cli.js";
import { runClaude } from "../../src/run/claude-run.js";
import { createClaudeRepairExecutor } from "../../src/repair/execute-claude-repair-cycle.js";
import { resolveStateRoot } from "../../src/state/state-root.js";
import type { IndependentReviewResult } from "../../src/review/independent-review.js";

const tempRepos: string[] = [];
const stateRoots: string[] = [];
const tempRoots: string[] = [];

after(() => {
  for (const root of stateRoots) {
    rmSync(root, { recursive: true, force: true });
  }
  for (const root of tempRoots) {
    rmSync(root, { recursive: true, force: true });
  }
  for (const repo of tempRepos) {
    rmSync(repo, { recursive: true, force: true });
  }
});

/** verifyCommand is injected rather than fixed: writeFakeClaudeCli always
 *  writes the same fixed content ("claude fake output\n"), so the only way
 *  to exercise "a real commit happened but the fix was still wrong" (not
 *  just "nothing was written at all") is a verify command that checks
 *  content, which that fixed text will never satisfy. */
function reviewWithFinding(runId: string, verifyCommand: string): IndependentReviewResult {
  return {
    schemaVersion: "1.0",
    runId,
    reviewId: "review-1",
    reviewer: "fake-reviewer",
    graphVersion: 1,
    createdAt: "2026-08-16T09:00:00Z",
    verdict: "fail",
    criterionCoverage: [
      { criterionId: "AC-01", verdict: "contradicted", tests: [], commands: [verifyCommand], evidence: "target.txt does not satisfy AC-01" }
    ],
    findings: [
      {
        id: "REV-001",
        severity: "blocking",
        category: "correctness",
        criterionIds: ["AC-01"],
        files: ["target.txt"],
        evidence: "target.txt is required by AC-01 but does not satisfy it."
      }
    ]
  };
}

const EXISTENCE_VERIFY = "node -e \"process.exit(require('fs').existsSync('target.txt') ? 0 : 1)\"";
const CONTENT_MARKER_VERIFY =
  "node -e \"process.exit(require('fs').existsSync('target.txt') && require('fs').readFileSync('target.txt','utf8').includes('REQUIRED_MARKER') ? 0 : 1)\"";

function reviewClean(runId: string): IndependentReviewResult {
  return { ...reviewWithFinding(runId, EXISTENCE_VERIFY), verdict: "pass", findings: [] };
}

function fakeCli(version: string, touchedFile: string | null): string {
  const root = mkdtempSync(join(tmpdir(), "aicw-fake-claude-repair-"));
  tempRoots.push(root);
  const cli = join(root, "claude-fake.mjs");
  writeFakeClaudeCli(cli, { version, ...(touchedFile ? { touchedFile } : {}) });
  chmodSync(cli, 0o755);
  return cli;
}

/** A task whose own plan has no verify commands, so buildCoverageReview's
 *  structural review always fails and independentReview is what actually
 *  gets exercised - same fixture shape as fake-run-repair.test.ts's
 *  createReviewFailingRepository, adapted for a real Claude-engine task. */
function createReviewFailingRepository(): string {
  const repo = mkdtempSync(join(tmpdir(), "aicw-claude-real-repair-"));
  tempRepos.push(repo);
  stateRoots.push(resolveStateRoot({ repoRoot: repo }).path);

  mkdirSync(join(repo, "Plan"), { recursive: true });
  writeFileSync(join(repo, "README.md"), "# fixture\n", "utf8");
  writeFileSync(
    join(repo, "Plan", "RUN.md"),
    `---
status: accepted
---

# Claude real-repair fixture plan

\`\`\`json ai-code-worker-plan
${JSON.stringify(
  {
    goal: "Execute a Claude-backed task whose review fails structurally, then repair it for real.",
    tasks: [
      {
        id: "CONTRACT-01",
        kind: "contract",
        role: "phase3-claude-worker",
        dependsOn: [],
        requiredInputs: ["README.md"],
        allowedPaths: ["src/**"],
        forbiddenPaths: [".git/**"],
        expectedArtifacts: [],
        acceptanceCriteria: ["Contract task has no verify command, so structural review always fails."],
        verify: [],
        concurrencyKeys: ["claude-real-repair"],
        risk: "low"
      }
    ],
    globalGates: ['node -e "process.exit(0)"'],
    budgets: {
      maximumParallelWriters: 1,
      maximumRepairCycles: 2,
      maximumTaskMinutes: 10,
      maximumRunMinutes: 30,
      maximumAgentInvocations: 4,
      maximumRunInputUncachedTokens: 100000,
      maximumRunCacheReadTokens: 100000,
      maximumRunCacheWriteTokens: 100000,
      maximumRunOutputTokens: 20000,
      maximumRunCostUsd: null,
      onUnknownUsage: "allow"
    }
  },
  null,
  2
)}
\`\`\`
`,
    "utf8"
  );
  execFileSync("git", ["init"], { cwd: repo, stdio: "ignore" });
  execFileSync("git", ["add", "."], { cwd: repo, stdio: "ignore" });
  execFileSync("git", ["-c", "user.name=ai-code-worker", "-c", "user.email=worker@example.test", "commit", "-m", "claude real-repair fixture"], {
    cwd: repo,
    env: { ...process.env, GIT_AUTHOR_DATE: "2026-08-16T09:00:00Z", GIT_COMMITTER_DATE: "2026-08-16T09:00:00Z" },
    stdio: "ignore"
  });

  return repo;
}

describe("claude run coordinator - real engine repair (todo.md #13, real-engine slice)", () => {
  it("dispatches a real (fake-CLI) Claude repair attempt that writes the missing file, and verify decides DONE for real", () => {
    const repo = createReviewFailingRepository();
    const stateRoot = resolveStateRoot({ repoRoot: repo }).path;
    const runId = "run-claude-real-repair-pass";
    // The original task writes something inside its own allowedPaths
    // (src/**) so it commits successfully - CONTRACT-01's plan declares no
    // verify commands, so buildCoverageReview's structural review fails
    // regardless of what the task wrote (same fixture reasoning as
    // fake-run-repair.test.ts's createReviewFailingRepository). The finding
    // below is about a *different* file, target.txt, which is what the
    // repair attempt's own fake CLI writes.
    const taskCli = fakeCli("2.1.177", "src/original-output.txt");
    const repairCli = fakeCli("2.1.177", "target.txt");

    const report = runClaude({
      repositoryPath: repo,
      planPath: "Plan/RUN.md",
      runId,
      now: "2026-08-16T09:05:00Z",
      adapterConfig: {
        executable: process.execPath,
        baseArgs: [taskCli],
        testedVersionRanges: ["2.1.177"],
        requiresCapabilitySmokeTest: true
      },
      independentReview: {
        reviewer: ({ runId: reviewedRunId }) => reviewWithFinding(reviewedRunId, EXISTENCE_VERIFY),
        executeRepairCycle: (repairBaseCommit: string) =>
          createClaudeRepairExecutor({
            repositoryPath: repo,
            stateRoot,
            runId,
            manifestSha256: "0".repeat(64),
            baseCommit: repairBaseCommit,
            adapterConfig: {
              executable: process.execPath,
              baseArgs: [repairCli],
              testedVersionRanges: ["2.1.177"],
              requiresCapabilitySmokeTest: true
            },
            reviewer: ({ runId: reviewedRunId }) => reviewClean(reviewedRunId)
          })
      }
    });

    assert.equal(report.status, "DONE");

    // The repair commit is real - read the file back from the repository,
    // not from an in-memory report field.
    const repairTaskIds = Object.keys(report.taskCommits).filter((id) => id.startsWith("REPAIR-"));
    assert.equal(repairTaskIds.length, 1);
    const repairCommit = report.taskCommits[repairTaskIds[0]!]!;
    const committedContent = execFileSync("git", ["show", `${repairCommit}:target.txt`], { cwd: repo, encoding: "utf8" });
    assert.match(committedContent, /claude fake output/);
  });

  it("does not falsely report DONE when the repair engine runs but the file still fails real verify", () => {
    const repo = createReviewFailingRepository();
    const stateRoot = resolveStateRoot({ repoRoot: repo }).path;
    const runId = "run-claude-real-repair-fail";
    // Same original-task setup as the PASSED case above - it must actually
    // commit so the run reaches review/repair at all, not stop earlier on
    // its own NO_CHANGES.
    const taskCli = fakeCli("2.1.177", "src/original-output.txt");
    // The repair attempt's CLI writes target.txt (in scope, so the commit
    // itself succeeds for real) but with its fixed fake content
    // ("claude fake output\n"), which never contains REQUIRED_MARKER. This
    // is the case that matters most: a real commit happening is not what
    // decides PASSED/FAILED - the task's own verify command is, and it must
    // keep failing for real against content that doesn't satisfy it.
    const repairCli = fakeCli("2.1.177", "target.txt");

    const report = runClaude({
      repositoryPath: repo,
      planPath: "Plan/RUN.md",
      runId,
      now: "2026-08-16T09:05:00Z",
      adapterConfig: {
        executable: process.execPath,
        baseArgs: [taskCli],
        testedVersionRanges: ["2.1.177"],
        requiresCapabilitySmokeTest: true
      },
      independentReview: {
        reviewer: ({ runId: reviewedRunId }) => reviewWithFinding(reviewedRunId, CONTENT_MARKER_VERIFY),
        executeRepairCycle: (repairBaseCommit: string) =>
          createClaudeRepairExecutor({
            repositoryPath: repo,
            stateRoot,
            runId,
            manifestSha256: "0".repeat(64),
            baseCommit: repairBaseCommit,
            adapterConfig: {
              executable: process.execPath,
              baseArgs: [repairCli],
              testedVersionRanges: ["2.1.177"],
              requiresCapabilitySmokeTest: true
            },
            // Identical evidence every cycle - the bounded loop stops early
            // on repeated-failure-no-progress rather than spinning forever.
            reviewer: ({ runId: reviewedRunId }) => reviewWithFinding(reviewedRunId, CONTENT_MARKER_VERIFY)
          })
      }
    });

    assert.equal(report.status, "BLOCKED");
    assert.equal(report.findings[0]?.code, "REPAIR_DID_NOT_RESOLVE_REVIEW");
    // The main repository's own working tree never sees repair worktree
    // writes directly (worker commits live on isolated branches) - this is
    // a sanity check, not the real assertion above.
    assert.equal(existsSync(join(repo, "target.txt")), false);
  });
});
