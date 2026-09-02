import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, describe, it } from "node:test";
import { runFake } from "../../src/run/fake-run.js";
import { EventLog, type RunEvent } from "../../src/persistence/event-log.js";
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

describe("recovery: process kill at specific pipeline points", () => {
  it("recovers when killed after all tasks finish but before the read-only review runs", () => {
    const repo = createSingleWriterRepository();
    const first = runFake({ repositoryPath: repo, planPath: "Plan/RUN.md", runId: "run-kill-before-review", now: "2026-08-01T10:00:00Z" });

    assert.equal(first.status, "DONE");

    const events = readEvents(first.state.eventLogPath!);
    const lastFinishedIndex = findLastIndex(events, (event) => event.type === "task.finished");

    assert.ok(lastFinishedIndex > 0, "fixture must reach at least one task.finished event");
    truncateEventLog(first.state.eventLogPath!, events.slice(0, lastFinishedIndex + 1));

    const recovered = runFake({
      repositoryPath: repo,
      planPath: "Plan/RUN.md",
      runId: "run-kill-before-review",
      now: "2026-08-01T10:05:00Z"
    });
    const recoveredEvents = readEvents(recovered.state.eventLogPath!);

    assert.equal(recovered.status, "DONE");
    assert.deepEqual(recovered.taskCommits, first.taskCommits);
    // Neither task re-executed: exactly one committed/finished event per task, matching the first run.
    for (const taskId of ["CONTRACT-01", "BACKEND-01"]) {
      assert.equal(recoveredEvents.filter((event) => event.type === "task.committed" && event.payload.taskId === taskId).length, 1);
      assert.equal(recoveredEvents.filter((event) => event.type === "task.finished" && event.payload.taskId === taskId).length, 1);
    }
    // Review and the final run.done are freshly (re-)appended exactly once.
    assert.equal(recoveredEvents.filter((event) => event.type === "review.finished").length, 1);
    assert.equal(recoveredEvents.filter((event) => event.type === "run.done").length, 1);

    const review = JSON.parse(readFileSync(join(recovered.state.runRoot!, "review.json"), "utf8"));
    assert.deepEqual(registry.validate("review.schema.json", review), { valid: true, errors: [] });
    assert.equal(review.status, "PASS");
  });

  it("recovers when killed after integration left a scratch worktree behind, without re-executing tasks", () => {
    const repo = createParallelRepository();
    const first = runFake({ repositoryPath: repo, planPath: "Plan/parallel.md", runId: "run-kill-during-integration", now: "2026-08-01T10:00:00Z" });

    assert.equal(first.status, "DONE");

    // Use the run's OWN returned state root rather than recomputing it via
    // resolveStateRoot({ repoRoot: repo }) - see the identical comment in
    // fake-run-repair.test.ts. Confirmed live on GitHub Actions windows-latest,
    // 2026-09-02: a second, independently-recomputed hash pointed at a directory
    // whose "worktrees" subdirectory did not even exist.
    const stateRoot = dirname(dirname(first.state.runRoot!));
    const integrationWorktreePath = join(
      stateRoot,
      "worktrees",
      "run-kill-during-integration",
      "__integration__",
      "attempt-1"
    );
    assert.equal(
      existsSync(integrationWorktreePath),
      true,
      `fixture must actually reach the integration step - path=${integrationWorktreePath}, ` +
        `runRoot exists=${existsSync(first.state.runRoot!)}, worktreesDirExists=${existsSync(join(stateRoot, "worktrees"))}`
    );

    const events = readEvents(first.state.eventLogPath!);
    const lastFinishedIndex = findLastIndex(events, (event) => event.type === "task.finished");
    truncateEventLog(first.state.eventLogPath!, events.slice(0, lastFinishedIndex + 1));
    // Deliberately do NOT remove integrationWorktreePath: a process kill right
    // after "git worktree add" for integration leaves exactly this behind -
    // the directory exists, but run.done was never appended.

    const recovered = runFake({
      repositoryPath: repo,
      planPath: "Plan/parallel.md",
      runId: "run-kill-during-integration",
      now: "2026-08-01T10:05:00Z"
    });
    const recoveredEvents = readEvents(recovered.state.eventLogPath!);

    assert.equal(recovered.status, "DONE");
    assert.deepEqual(recovered.taskCommits, first.taskCommits);

    for (const taskId of ["TASK-A", "TASK-B"]) {
      assert.equal(recoveredEvents.filter((event) => event.type === "task.committed" && event.payload.taskId === taskId).length, 1);
    }

    const integrationReport = JSON.parse(readFileSync(join(recovered.state.runRoot!, "integration-report.json"), "utf8"));
    assert.equal(integrationReport.status, "OK");
    assert.deepEqual([...integrationReport.integratedTaskIds].sort(), ["TASK-A", "TASK-B"]);
  });
});

function findLastIndex<T>(items: readonly T[], predicate: (item: T) => boolean): number {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    if (predicate(items[index]!)) {
      return index;
    }
  }

  return -1;
}

function readEvents(eventLogPath: string): RunEvent[] {
  return readFileSync(eventLogPath, "utf8")
    .trim()
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line) as RunEvent);
}

function truncateEventLog(eventLogPath: string, events: readonly RunEvent[]): void {
  writeFileSync(eventLogPath, `${events.map((event) => JSON.stringify(event)).join("\n")}\n`, "utf8");
}

function createSingleWriterRepository(): string {
  const repo = mkdtempSync(join(tmpdir(), "aicw-recovery-review-"));
  tempRepos.push(repo);
  stateRoots.push(resolveStateRoot({ repoRoot: repo }).path);

  mkdirSync(join(repo, "Plan"), { recursive: true });
  writeFileSync(join(repo, "README.md"), "# fixture\n", "utf8");
  writeFileSync(join(repo, "Plan", "RUN.md"), acceptedPlan(singleWriterPlanBody()), "utf8");
  initRepo(repo);

  return repo;
}

function singleWriterPlanBody(): unknown {
  return {
    goal: "Execute a deterministic fake task flow.",
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
        verify: ['node -e "process.exit(0)"'],
        concurrencyKeys: ["fake-run"],
        risk: "low"
      },
      {
        id: "BACKEND-01",
        kind: "backend",
        role: "phase0-worker",
        dependsOn: ["CONTRACT-01"],
        requiredInputs: ["README.md"],
        allowedPaths: ["src/**"],
        forbiddenPaths: [".git/**"],
        expectedArtifacts: [],
        acceptanceCriteria: ["Backend task sees the contract dependency commit."],
        verify: ['node -e "process.exit(0)"'],
        concurrencyKeys: ["fake-run"],
        risk: "low"
      }
    ],
    globalGates: ['node -e "process.exit(0)"'],
    budgets: {
      maximumParallelWriters: 1,
      maximumRepairCycles: 0,
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
  };
}

function createParallelRepository(): string {
  const repo = mkdtempSync(join(tmpdir(), "aicw-recovery-integration-"));
  tempRepos.push(repo);
  stateRoots.push(resolveStateRoot({ repoRoot: repo }).path);

  mkdirSync(join(repo, "Plan"), { recursive: true });
  writeFileSync(join(repo, "README.md"), "# fixture\n", "utf8");
  writeFileSync(join(repo, "Plan", "parallel.md"), acceptedPlan(parallelPlanBody()), "utf8");
  initRepo(repo);

  return repo;
}

function parallelPlanBody(): unknown {
  return {
    goal: "Run two independent tasks that require integration.",
    tasks: [
      {
        id: "TASK-A",
        kind: "backend",
        role: "phase3-recovery-worker",
        dependsOn: [],
        requiredInputs: ["README.md"],
        allowedPaths: ["src/task-a/**"],
        forbiddenPaths: [".git/**"],
        expectedArtifacts: [],
        acceptanceCriteria: ["TASK-A writes its output file."],
        verify: [`node -e "process.exit(require('fs').existsSync('src/task-a/ai-code-worker-task-a.txt') ? 0 : 1)"`],
        concurrencyKeys: ["task-a-key"],
        risk: "low"
      },
      {
        id: "TASK-B",
        kind: "backend",
        role: "phase3-recovery-worker",
        dependsOn: [],
        requiredInputs: ["README.md"],
        allowedPaths: ["src/task-b/**"],
        forbiddenPaths: [".git/**"],
        expectedArtifacts: [],
        acceptanceCriteria: ["TASK-B writes its output file."],
        verify: [`node -e "process.exit(require('fs').existsSync('src/task-b/ai-code-worker-task-b.txt') ? 0 : 1)"`],
        concurrencyKeys: ["task-b-key"],
        risk: "low"
      }
    ],
    globalGates: [],
    budgets: {
      maximumParallelWriters: 2,
      maximumRepairCycles: 0,
      maximumTaskMinutes: 10,
      maximumRunMinutes: 30,
      maximumAgentInvocations: 2,
      maximumRunInputUncachedTokens: 100000,
      maximumRunCacheReadTokens: 100000,
      maximumRunCacheWriteTokens: 100000,
      maximumRunOutputTokens: 20000,
      maximumRunCostUsd: null,
      onUnknownUsage: "allow"
    }
  };
}

function acceptedPlan(body: unknown): string {
  return `---
status: accepted
---

# Recovery fixture plan

\`\`\`json ai-code-worker-plan
${JSON.stringify(body, null, 2)}
\`\`\`
`;
}

function initRepo(repo: string): void {
  execFileSync("git", ["init"], { cwd: repo, stdio: "ignore" });
  execFileSync("git", ["add", "."], { cwd: repo, stdio: "ignore" });
  execFileSync("git", ["-c", "user.name=ai-code-worker", "-c", "user.email=worker@example.test", "commit", "-m", "recovery fixture"], {
    cwd: repo,
    env: {
      ...process.env,
      GIT_AUTHOR_DATE: "2026-08-01T10:00:00Z",
      GIT_COMMITTER_DATE: "2026-08-01T10:00:00Z"
    },
    stdio: "ignore"
  });
}
