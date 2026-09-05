import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { runCodex } from "../../src/run/codex-run.js";
import { taskWorktreeBranch, taskWorktreePath } from "../../src/git/worktree.js";
import { resolveStateRoot } from "../../src/state/state-root.js";

// Real-world finding (a consumer project's Orders feature pilot, 2026-08-30): a 10-task
// run hit a Codex rate limit mid-run and the pilot's own report says "the worker retained
// only the rate-limited task's invocation... the usage result is, correctly, inconclusive."
// Tracing this in codex-run.ts found two separate silent-data-loss bugs, both fixed here:
//
// 1. A task's own usage was only folded into the run's usageTotals AFTER it fully
//    succeeded (committed + gates passed) - a task that consumed real, billable tokens
//    before failing/being rate-limited had that usage discarded entirely.
// 2. On resume, an already-finished task's real usage was replaced with all-null
//    unknownUsage() instead of being recovered from its persisted evidence.json - poisons
//    the whole run's final totals to null via addUsage's fail-closed null propagation.
//
// Both tests below reproduce the exact shape of the pilot's scenario with a bespoke fake
// Codex CLI (not the shared writeFakeCodexCli helper, which has no notion of a task that
// reports partial usage and then dies) and assert against the numbers a hand computation
// predicts, so a regression silently reintroducing either bug fails loudly.

const tempRepos: string[] = [];
const stateRoots: string[] = [];
const tempRoots: string[] = [];

after(() => {
  for (const root of stateRoots) rmSync(root, { recursive: true, force: true });
  for (const root of tempRoots) rmSync(root, { recursive: true, force: true });
  for (const repo of tempRepos) rmSync(repo, { recursive: true, force: true });
});

interface TaskUsagePlan {
  readonly outcome: "done" | "rate-limited";
  readonly inputTokens: number;
  readonly cachedInputTokens: number;
  readonly outputTokens: number;
}

describe("usage persistence: a task's own usage survives even when that task fails", () => {
  it("folds a rate-limited task's partial usage into the run's BLOCKED report instead of discarding it", async () => {
    const repo = createTwoTaskRepository("run-usage-drop-on-failure");
    const cli = fakeCodexCli({
      "TASK-01": { outcome: "done", inputTokens: 1000, cachedInputTokens: 500, outputTokens: 200 },
      "TASK-02": { outcome: "rate-limited", inputTokens: 2000, cachedInputTokens: 800, outputTokens: 50 }
    });

    const report = await runCodex({
      repositoryPath: repo,
      planPath: "Plan/RUN.md",
      runId: "run-usage-drop-on-failure",
      now: "2026-08-01T10:00:00Z",
      adapterConfig: { executable: process.execPath, baseArgs: [cli], testedVersionRanges: ["1.0.0-fake"], requiresCapabilitySmokeTest: true }
    });

    assert.equal(report.status, "BLOCKED");
    assert.deepEqual(report.executedTasks, ["TASK-01"]);

    const runReport = JSON.parse(readFileSync(join(report.state.runRoot!, "run-report.json"), "utf8"));
    // Before the fix: TASK-02 never reached addUsage(), so this would be 500/500/200
    // (TASK-01 only). After the fix, TASK-02's own partial usage is included too.
    assert.equal(runReport.usage.inputUncachedTokens, 500 + 1200);
    assert.equal(runReport.usage.cacheReadTokens, 500 + 800);
    assert.equal(runReport.usage.outputTokens, 200 + 50);
  });
});

describe("usage persistence: resuming a run recovers real usage instead of substituting unknown", () => {
  it("reads an already-finished task's real usage from its evidence.json on resume, not unknownUsage()", async () => {
    const runId = "run-usage-resume";
    const repo = createTwoTaskRepository("run-usage-resume");
    const firstAttemptCli = fakeCodexCli({
      "TASK-01": { outcome: "done", inputTokens: 1000, cachedInputTokens: 500, outputTokens: 200 },
      "TASK-02": { outcome: "done", inputTokens: 2000, cachedInputTokens: 800, outputTokens: 50 }
    });

    const first = await runCodex({
      repositoryPath: repo,
      planPath: "Plan/RUN.md",
      runId,
      now: "2026-08-01T10:00:00Z",
      adapterConfig: { executable: process.execPath, baseArgs: [firstAttemptCli], testedVersionRanges: ["1.0.0-fake"], requiresCapabilitySmokeTest: true }
    });
    assert.equal(first.status, "DONE");
    assert.deepEqual(first.executedTasks, ["TASK-01", "TASK-02"]);

    // Simulate "the process was killed right after TASK-01 finished, before TASK-02 ever
    // started": truncate the event log to just after TASK-01's task.finished event, and
    // remove TASK-02's worktree/branch the completed run above actually created (a real
    // crash at that point would never have created them).
    simulateCrashAfterTaskFinished(repo, first.state.eventLogPath!, runId, "TASK-01", "TASK-02");

    // The quota resets: TASK-02 completes normally on retry. TASK-01's numbers here are
    // deliberately huge and obviously wrong - if recovery incorrectly re-executed TASK-01
    // instead of recovering it from evidence.json, these would leak into the final total
    // and this test would still fail, just with a different (wrong) number instead of null.
    const secondAttemptCli = fakeCodexCli({
      "TASK-01": { outcome: "done", inputTokens: 999_999, cachedInputTokens: 999_999, outputTokens: 999_999 },
      "TASK-02": { outcome: "done", inputTokens: 3000, cachedInputTokens: 1000, outputTokens: 400 }
    });

    const resumed = await runCodex({
      repositoryPath: repo,
      planPath: "Plan/RUN.md",
      runId,
      now: "2026-08-01T10:05:00Z",
      adapterConfig: { executable: process.execPath, baseArgs: [secondAttemptCli], testedVersionRanges: ["1.0.0-fake"], requiresCapabilitySmokeTest: true }
    });

    assert.equal(resumed.status, "DONE");
    assert.deepEqual(resumed.executedTasks, ["TASK-01", "TASK-02"]);

    const runReport = JSON.parse(readFileSync(join(resumed.state.runRoot!, "run-report.json"), "utf8"));
    // Before the fix: TASK-01's recovered usage was unknownUsage() (all null), and
    // addUsage's null propagation would have poisoned every one of these fields to null
    // for the whole run, even though TASK-02 completed with real numbers. After the fix,
    // TASK-01 contributes its real, persisted 500/500/200.
    assert.equal(runReport.usage.inputUncachedTokens, 500 + 2000);
    assert.equal(runReport.usage.cacheReadTokens, 500 + 1000);
    assert.equal(runReport.usage.outputTokens, 200 + 400);
  });
});

interface RunEventLike {
  readonly type: string;
  readonly payload: { readonly taskId?: string };
}

/** Truncates a completed run's event log back to just after `keepThroughTaskId`'s
 *  task.finished event, and removes the worktree/branch a later task
 *  (`neverStartedTaskId`) actually created during the completed run - since a real
 *  crash at that point would never have created them. Mirrors recovery.test.ts's
 *  event-log truncation technique, extended to also undo the one piece of git-level
 *  state (`git worktree add`'s branch + directory) that a genuinely-never-started task
 *  would never have left behind. */
function simulateCrashAfterTaskFinished(
  repo: string,
  eventLogPath: string,
  runId: string,
  keepThroughTaskId: string,
  neverStartedTaskId: string
): void {
  const events = readFileSync(eventLogPath, "utf8")
    .trim()
    .split(/\r?\n/)
    .map((line) => JSON.parse(line) as RunEventLike);
  const cutIndex = events.findIndex((event) => event.type === "task.finished" && event.payload.taskId === keepThroughTaskId);
  assert.ok(cutIndex >= 0, `fixture must reach task.finished for ${keepThroughTaskId}`);
  writeFileSync(eventLogPath, `${events.slice(0, cutIndex + 1).map((event) => JSON.stringify(event)).join("\n")}\n`, "utf8");

  const stateRoot = resolveStateRoot({ repoRoot: repo }).path;
  const branch = taskWorktreeBranch({ runId, taskId: neverStartedTaskId, attempt: 1 });
  rmSync(taskWorktreePath({ stateRoot, runId, taskId: neverStartedTaskId, attempt: 1 }), { recursive: true, force: true });
  execFileSync("git", ["worktree", "prune"], { cwd: repo });
  execFileSync("git", ["branch", "-D", branch], { cwd: repo, stdio: "ignore" });
}

function fakeCodexCli(tasks: Readonly<Record<string, TaskUsagePlan>>): string {
  const root = mkdtempSync(join(tmpdir(), "aicw-usage-fake-codex-"));
  tempRoots.push(root);
  const cli = join(root, "codex-fake.mjs");
  writeFileSync(
    cli,
    `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args.includes("--version")) { console.log("codex-cli 1.0.0-fake"); process.exit(0); }
if (args[0] === "exec" && args.includes("--help")) { console.log("--json\\n--cd\\n--sandbox"); process.exit(0); }
if (args[0] === "exec") {
  const fs = await import("node:fs");
  let request = {};
  try { request = JSON.parse(fs.readFileSync(0, "utf8")); } catch {}
  const plans = ${JSON.stringify(tasks)};
  const plan = plans[request.taskId];
  console.log(JSON.stringify({ type: "thread.started", thread_id: "fake-thread" }));
  console.log(JSON.stringify({ type: "turn.started" }));
  console.log(JSON.stringify({
    type: "event_msg",
    payload: { type: "token_count", info: { total_token_usage: {
      input_tokens: plan.inputTokens, cached_input_tokens: plan.cachedInputTokens, output_tokens: plan.outputTokens
    } }, rate_limits: { primary: { used_percent: 0 } } }
  }));
  if (plan.outcome === "rate-limited") {
    // A real rate-limit death: usage was already reported above, but the process dies
    // before ever producing a parseable final result - no item.completed, exit 1.
    process.exit(1);
  }
  const touchedFile = "src/" + request.taskId + ".txt";
  fs.mkdirSync("src", { recursive: true });
  fs.writeFileSync(touchedFile, "usage persistence fixture output\\n");
  const result = { schemaVersion: "1.0", runId: request.runId, taskId: request.taskId, status: "DONE", summary: "fake done", touchedFiles: [touchedFile], failures: [] };
  console.log(JSON.stringify({ type: "item.completed", item: { id: "item_0", type: "agent_message", text: JSON.stringify(result) } }));
  process.exit(0);
}
process.exit(2);
`,
    "utf8"
  );
  chmodSync(cli, 0o755);
  return cli;
}

function createTwoTaskRepository(prefix: string): string {
  const repo = mkdtempSync(join(tmpdir(), `aicw-${prefix}-`));
  tempRepos.push(repo);
  stateRoots.push(resolveStateRoot({ repoRoot: repo }).path);

  mkdirSync(join(repo, "Plan"), { recursive: true });
  writeFileSync(join(repo, "README.md"), "# fixture\n", "utf8");
  writeFileSync(join(repo, "Plan", "RUN.md"), acceptedPlan(), "utf8");
  execFileSync("git", ["init"], { cwd: repo, stdio: "ignore" });
  execFileSync("git", ["add", "."], { cwd: repo, stdio: "ignore" });
  execFileSync("git", ["-c", "user.name=ai-code-worker", "-c", "user.email=worker@example.test", "commit", "-m", "usage persistence fixture"], {
    cwd: repo,
    env: { ...process.env, GIT_AUTHOR_DATE: "2026-08-01T10:00:00Z", GIT_COMMITTER_DATE: "2026-08-01T10:00:00Z" },
    stdio: "ignore"
  });

  return repo;
}

function acceptedPlan(): string {
  return `---
status: accepted
---

# Usage persistence fixture plan

\`\`\`json ai-code-worker-plan
${JSON.stringify(planBody(), null, 2)}
\`\`\`
`;
}

function planBody(): unknown {
  return {
    goal: "Two sequential Codex-backed tasks, the second of which may be rate-limited.",
    tasks: [
      {
        id: "TASK-01",
        kind: "backend",
        role: "phase1-codex-worker",
        dependsOn: [],
        requiredInputs: ["README.md"],
        allowedPaths: ["src/**"],
        forbiddenPaths: [".git/**"],
        expectedArtifacts: [],
        acceptanceCriteria: ["TASK-01 completes."],
        verify: ['node -e "process.exit(0)"'],
        concurrencyKeys: ["usage-persistence"],
        risk: "low"
      },
      {
        id: "TASK-02",
        kind: "backend",
        role: "phase1-codex-worker",
        dependsOn: ["TASK-01"],
        requiredInputs: ["README.md"],
        allowedPaths: ["src/**"],
        forbiddenPaths: [".git/**"],
        expectedArtifacts: [],
        acceptanceCriteria: ["TASK-02 completes."],
        verify: ['node -e "process.exit(0)"'],
        concurrencyKeys: ["usage-persistence"],
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
      maximumRunInputUncachedTokens: 1000000,
      maximumRunCacheReadTokens: 1000000,
      maximumRunCacheWriteTokens: 1000000,
      maximumRunOutputTokens: 1000000,
      maximumRunCostUsd: null,
      onUnknownUsage: "allow"
    }
  };
}
