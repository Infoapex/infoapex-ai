import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, describe, it } from "node:test";
import { runFake } from "../../src/run/fake-run.js";
import { createTaskWorktree } from "../../src/git/worktree.js";
import { createWorkerCommit } from "../../src/git/commit.js";
import { currentHead } from "../../src/git/diff.js";
import type { RepairCycleExecutionResult } from "../../src/repair/repair-cycle.js";
import type { IndependentReviewResult } from "../../src/review/independent-review.js";
import { EventLog } from "../../src/persistence/event-log.js";
import { SchemaRegistry } from "../../src/schema/json-schema.js";
import { resolveStateRoot } from "../../src/state/state-root.js";

const tempRepos: string[] = [];
const stateRoots: string[] = [];
const registry = SchemaRegistry.load({ schemaDirectory: "schemas" });

after(() => {
  for (const root of stateRoots) {
    rmSync(root, { recursive: true, force: true });
  }

  for (const repo of tempRepos) {
    rmSync(repo, { recursive: true, force: true });
  }
});

function reviewWithFinding(runId: string): IndependentReviewResult {
  return {
    schemaVersion: "1.0",
    runId,
    reviewId: "review-1",
    reviewer: "fake-reviewer",
    graphVersion: 1,
    createdAt: "2026-08-15T09:00:00Z",
    verdict: "fail",
    criterionCoverage: [
      { criterionId: "AC-01", verdict: "contradicted", tests: [], commands: ["node -e \"process.exit(0)\""], evidence: "coverage gap" }
    ],
    findings: [
      {
        id: "REV-001",
        severity: "blocking",
        category: "correctness",
        criterionIds: ["AC-01"],
        files: ["src/fix-target.txt"],
        evidence: "Contract task output is missing the required marker."
      }
    ]
  };
}

function reviewClean(runId: string): IndependentReviewResult {
  return { ...reviewWithFinding(runId), verdict: "pass", findings: [] };
}

describe("fake run coordinator - independent review + repair wiring", () => {
  it("reaches DONE after a repair cycle resolves the only blocking finding", () => {
    const repo = createReviewFailingRepository();
    const baseCommit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim();
    const runId = "run-repair-resolve";
    const stateRoot = resolveStateRoot({ repoRoot: repo }).path;

    const report = runFake({
      repositoryPath: repo,
      planPath: "Plan/RUN.md",
      runId,
      now: "2026-08-01T10:00:00Z",
      independentReview: {
        reviewer: ({ runId: reviewedRunId }) => reviewWithFinding(reviewedRunId),
        executeRepairCycle: ({ tasks }): RepairCycleExecutionResult => {
          const task = tasks[0]!;
          const worktree = createTaskWorktree({
            repositoryPath: repo,
            stateRoot,
            runId,
            taskId: task.id,
            attempt: 1,
            baseCommit
          });
          assert.equal(worktree.status, "CREATED");

          mkdirSync(join(worktree.worktree!.path, "src"), { recursive: true });
          writeFileSync(join(worktree.worktree!.path, "src", "fix-target.txt"), "marker present\n", "utf8");

          const expectedHead = currentHead(worktree.worktree!.path);
          const commit = createWorkerCommit({
            worktreePath: worktree.worktree!.path,
            expectedHead,
            runId,
            taskId: task.id,
            manifestSha256: "0".repeat(64),
            allowedPaths: task.allowedPaths,
            forbiddenPaths: task.forbiddenPaths,
            message: `Repair ${task.id}`
          });
          assert.equal(commit.status, "COMMITTED");

          return {
            taskOutcomes: [{ taskId: task.id, outcome: "PASSED", commit: commit.commit!.sha, evidenceRef: null }],
            reviewAfterCycle: reviewClean(runId)
          };
        }
      }
    });

    assert.equal(report.status, "DONE");

    const events = new EventLog(report.state.eventLogPath!, registry).read().events;
    assert.ok(events.some((event) => event.type === "repair.budget-initialized"));
    assert.ok(events.some((event) => event.type === "repair.attempt-finished"));
    assert.equal(events.some((event) => event.type === "repair.cycle-exhausted"), false);
    assert.equal(existsSync(join(report.state.runRoot!, "repairs", "repair-evidence.md")), true);
    assert.equal(existsSync(join(report.state.runRoot!, "BLOCKED.md")), false);
  });

  it("writes BLOCKED.md and repair evidence when repair never resolves the finding", () => {
    const repo = createReviewFailingRepository();
    const runId = "run-repair-exhausted";

    const report = runFake({
      repositoryPath: repo,
      planPath: "Plan/RUN.md",
      runId,
      now: "2026-08-01T10:00:00Z",
      independentReview: {
        reviewer: ({ runId: reviewedRunId }) => reviewWithFinding(reviewedRunId),
        executeRepairCycle: ({ tasks }): RepairCycleExecutionResult => ({
          taskOutcomes: tasks.map((task) => ({ taskId: task.id, outcome: "FAILED", commit: null, evidenceRef: null })),
          // Identical evidence every cycle - stops early on repeated-failure-no-progress.
          reviewAfterCycle: reviewWithFinding(runId)
        })
      }
    });

    assert.equal(report.status, "BLOCKED");
    assert.equal(report.findings[0]?.code, "REPAIR_DID_NOT_RESOLVE_REVIEW");

    const blockedPath = join(report.state.runRoot!, "BLOCKED.md");
    assert.equal(existsSync(blockedPath), true);
    const blockedContent = readFileSync(blockedPath, "utf8");
    assert.match(blockedContent, /REPAIR_DID_NOT_RESOLVE_REVIEW/);
    assert.match(blockedContent, /repairs\/repair-evidence\.md/);

    const evidencePath = join(report.state.runRoot!, "repairs", "repair-evidence.md");
    assert.equal(existsSync(evidencePath), true);
    assert.match(readFileSync(evidencePath, "utf8"), /Stop reason: repeated-failure-no-progress/);

    const runReport = JSON.parse(readFileSync(join(report.state.runRoot!, "run-report.json"), "utf8"));
    assert.equal(runReport.status, "BLOCKED");
  });

  it("recovers when killed during repair compilation/execution, without re-executing the original task", () => {
    const repo = createReviewFailingRepository();
    const baseCommit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim();
    const runId = "run-repair-kill-resume";

    // First attempt: repair never resolves (simulates the state left behind
    // right before/during a process kill mid-repair - the run never reaches
    // run.done). We only need its event log, not its returned status.
    const firstAttempt = runFake({
      repositoryPath: repo,
      planPath: "Plan/RUN.md",
      runId,
      now: "2026-08-01T10:00:00Z",
      independentReview: {
        reviewer: ({ runId: reviewedRunId }) => reviewWithFinding(reviewedRunId),
        executeRepairCycle: ({ tasks }): RepairCycleExecutionResult => ({
          taskOutcomes: tasks.map((task) => ({ taskId: task.id, outcome: "FAILED", commit: null, evidenceRef: null })),
          reviewAfterCycle: reviewWithFinding(runId)
        })
      }
    });

    // Use the run's OWN returned paths rather than recomputing them via
    // resolveStateRoot({ repoRoot: repo }) - gitPreflight() resolves `repo` through
    // `git rev-parse --show-toplevel`, which is not guaranteed to be the same string
    // as the raw fixture path on every platform, and resolveStateRoot() hashes
    // whatever string it is given. A second, independently-recomputed hash can
    // therefore point at a different (empty) state directory than the one the run
    // actually used - confirmed live on GitHub Actions windows-latest, 2026-09-02.
    const eventLogPath = firstAttempt.state.eventLogPath!;
    const stateRoot = dirname(dirname(firstAttempt.state.runRoot!));
    const events = new EventLog(eventLogPath, registry).read().events;
    const lastOriginalTaskFinished = events.findLastIndex(
      (event) => event.type === "task.finished" && event.payload.taskId === "CONTRACT-01"
    );
    assert.ok(
      lastOriginalTaskFinished >= 0,
      `fixture must reach the original task's completion - first attempt status=${firstAttempt.status}, ` +
        `findings=${JSON.stringify(firstAttempt.findings)}, eventTypes=${JSON.stringify(events.map((event) => event.type))}`
    );
    writeFileSync(
      eventLogPath,
      `${events
        .slice(0, lastOriginalTaskFinished + 1)
        .map((event) => JSON.stringify(event))
        .join("\n")}\n`,
      "utf8"
    );

    // Second attempt: same run id, resumed after the simulated kill. This
    // time the repair executor succeeds - proving repair compiles and
    // executes cleanly from the recovered state rather than being wedged
    // by whatever the killed attempt left behind.
    const recovered = runFake({
      repositoryPath: repo,
      planPath: "Plan/RUN.md",
      runId,
      now: "2026-08-01T10:10:00Z",
      independentReview: {
        reviewer: ({ runId: reviewedRunId }) => reviewWithFinding(reviewedRunId),
        executeRepairCycle: ({ tasks }): RepairCycleExecutionResult => {
          const task = tasks[0]!;
          const worktree = createTaskWorktree({
            repositoryPath: repo,
            stateRoot,
            runId,
            taskId: task.id,
            attempt: 1,
            baseCommit,
            recreateIfExists: true
          });
          assert.equal(worktree.status, "CREATED");

          mkdirSync(join(worktree.worktree!.path, "src"), { recursive: true });
          writeFileSync(join(worktree.worktree!.path, "src", "fix-target.txt"), "marker present\n", "utf8");

          const expectedHead = currentHead(worktree.worktree!.path);
          const commit = createWorkerCommit({
            worktreePath: worktree.worktree!.path,
            expectedHead,
            runId,
            taskId: task.id,
            manifestSha256: "0".repeat(64),
            allowedPaths: task.allowedPaths,
            forbiddenPaths: task.forbiddenPaths,
            message: `Repair ${task.id} (resumed)`
          });
          assert.equal(commit.status, "COMMITTED");

          return {
            taskOutcomes: [{ taskId: task.id, outcome: "PASSED", commit: commit.commit!.sha, evidenceRef: null }],
            reviewAfterCycle: reviewClean(runId)
          };
        }
      }
    });

    assert.equal(recovered.status, "DONE");

    const recoveredEvents = new EventLog(recovered.state.eventLogPath!, registry).read().events;
    assert.equal(
      recoveredEvents.filter((event) => event.type === "task.finished" && event.payload.taskId === "CONTRACT-01").length,
      1,
      "the original task must not be re-executed on resume"
    );
    assert.ok(recoveredEvents.some((event) => event.type === "repair.attempt-finished"));
  });

  it("preserves existing behavior (immediate block, no repair artifacts) when the hook is omitted", () => {
    const repo = createReviewFailingRepository();

    const report = runFake({
      repositoryPath: repo,
      planPath: "Plan/RUN.md",
      runId: "run-no-hook",
      now: "2026-08-01T10:00:00Z"
    });

    assert.equal(report.status, "BLOCKED");
    assert.equal(report.findings[0]?.code, "REVIEW_FAILED");
    assert.equal(existsSync(join(report.state.runRoot!, "repairs")), false);
  });
});

function createReviewFailingRepository(): string {
  const repo = mkdtempSync(join(tmpdir(), "aicw-fake-repair-"));
  tempRepos.push(repo);
  stateRoots.push(resolveStateRoot({ repoRoot: repo }).path);

  mkdirSync(join(repo, "Plan"), { recursive: true });
  writeFileSync(join(repo, "README.md"), "# fixture\n", "utf8");
  writeFileSync(
    join(repo, "Plan", "RUN.md"),
    `---
status: accepted
---

# Repair wiring fixture plan

\`\`\`json ai-code-worker-plan
${JSON.stringify(
  {
    goal: "Execute a deterministic fake task flow whose review fails structurally.",
    tasks: [
      {
        id: "CONTRACT-01",
        kind: "contract",
        role: "phase0-worker",
        dependsOn: [],
        requiredInputs: ["README.md"],
        allowedPaths: ["schemas/**"],
        forbiddenPaths: [".git/**"],
        expectedArtifacts: [],
        acceptanceCriteria: ["Contract task receives an empty dependency snapshot."],
        // No verify commands: buildCoverageReview cannot link evidence to this
        // criterion, so the structural review always fails and the
        // independent-review hook is what gets exercised.
        verify: [],
        concurrencyKeys: ["fake-run"],
        risk: "low"
      }
    ],
    globalGates: ['node -e "process.exit(0)"'],
    budgets: {
      maximumParallelWriters: 1,
      maximumRepairCycles: 2,
      maximumTaskMinutes: 10,
      maximumRunMinutes: 30,
      maximumAgentInvocations: 2,
      maximumRunInputUncachedTokens: 100000,
      maximumRunCacheReadTokens: 100000,
      maximumRunCacheWriteTokens: 100000,
      maximumRunOutputTokens: 20000,
      maximumRunCostUsd: null,
      onUnknownUsage: "block"
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
  execFileSync("git", ["-c", "user.name=ai-code-worker", "-c", "user.email=worker@example.test", "commit", "-m", "repair wiring fixture"], {
    cwd: repo,
    env: { ...process.env, GIT_AUTHOR_DATE: "2026-08-01T10:00:00Z", GIT_COMMITTER_DATE: "2026-08-01T10:00:00Z" },
    stdio: "ignore"
  });

  return repo;
}
