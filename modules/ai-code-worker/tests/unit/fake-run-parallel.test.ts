import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { runFake } from "../../src/run/fake-run.js";
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

describe("fake run coordinator - parallel DAG scheduling", () => {
  it("dispatches two compatible independent tasks in a single wave and integrates them deterministically", () => {
    const repo = createGitRepository("parallel-compatible.md", compatiblePlanBody());
    const report = runFake({
      repositoryPath: repo,
      planPath: "Plan/parallel-compatible.md",
      runId: "run-parallel-compat",
      now: "2026-08-01T10:00:00Z"
    });

    assert.equal(report.status, "DONE");
    assert.deepEqual([...report.executedTasks].sort(), ["TASK-A", "TASK-B"]);

    const events = new EventLog(report.state.eventLogPath!, registry).read().events;
    const waveEvents = events.filter((event) => event.type === "run.wave-dispatched");

    assert.equal(waveEvents.length, 1);
    assert.deepEqual([...(waveEvents[0]!.payload.taskIds as string[])].sort(), ["TASK-A", "TASK-B"]);

    const integrationReportPath = join(report.state.runRoot!, "integration-report.json");
    assert.equal(existsSync(integrationReportPath), true);
    const integrationReport = JSON.parse(readFileSync(integrationReportPath, "utf8"));
    assert.equal(integrationReport.status, "OK");
    assert.deepEqual([...integrationReport.integratedTaskIds].sort(), ["TASK-A", "TASK-B"]);
  });

  it("never dispatches two tasks with overlapping allowedPaths in the same wave", () => {
    const repo = createGitRepository("parallel-incompatible.md", incompatiblePlanBody());
    const report = runFake({
      repositoryPath: repo,
      planPath: "Plan/parallel-incompatible.md",
      runId: "run-parallel-incompat",
      now: "2026-08-01T10:00:00Z"
    });

    assert.equal(report.status, "DONE");
    assert.deepEqual([...report.executedTasks].sort(), ["TASK-C", "TASK-D"]);

    const events = new EventLog(report.state.eventLogPath!, registry).read().events;
    const waveEvents = events.filter((event) => event.type === "run.wave-dispatched");

    // Two overlapping tasks under maximumParallelWriters=2 must still land in separate
    // waves, one task each - the overlap guard takes priority over the parallel cap.
    assert.equal(waveEvents.length, 2);
    for (const event of waveEvents) {
      assert.equal((event.payload.taskIds as string[]).length, 1);
    }
  });
});

function createGitRepository(planFileName: string, planBody: unknown): string {
  const repo = mkdtempSync(join(tmpdir(), "aicw-fake-parallel-"));
  tempRepos.push(repo);
  stateRoots.push(resolveStateRoot({ repoRoot: repo }).path);

  mkdirSync(join(repo, "Plan"), { recursive: true });
  writeFileSync(join(repo, "README.md"), "# fixture\n", "utf8");
  writeFileSync(join(repo, "Plan", planFileName), acceptedPlan(planBody), "utf8");
  execFileSync("git", ["init"], { cwd: repo, stdio: "ignore" });
  execFileSync("git", ["add", "README.md", `Plan/${planFileName}`], { cwd: repo, stdio: "ignore" });
  execFileSync("git", ["-c", "user.name=ai-code-worker", "-c", "user.email=worker@example.test", "commit", "-m", "parallel fixture"], {
    cwd: repo,
    env: {
      ...process.env,
      GIT_AUTHOR_DATE: "2026-08-01T10:00:00Z",
      GIT_COMMITTER_DATE: "2026-08-01T10:00:00Z"
    },
    stdio: "ignore"
  });

  return repo;
}

function acceptedPlan(body: unknown): string {
  return `---
status: accepted
---

# Parallel fake run plan

\`\`\`json ai-code-worker-plan
${JSON.stringify(body, null, 2)}
\`\`\`
`;
}

function compatiblePlanBody(): unknown {
  return compatiblePlanBodyFor("TASK-A", "TASK-B");
}

function compatiblePlanBodyFor(idA: string, idB: string): unknown {
  return {
    goal: "Run two independent tasks in parallel.",
    tasks: [
      {
        id: idA,
        kind: "backend",
        role: "phase2-parallel-worker",
        dependsOn: [],
        requiredInputs: ["README.md"],
        allowedPaths: [`src/${idA.toLowerCase()}/**`],
        forbiddenPaths: [".git/**"],
        expectedArtifacts: [],
        acceptanceCriteria: [`${idA} writes its output file.`],
        verify: [`node -e "process.exit(require('fs').existsSync('src/${idA.toLowerCase()}/ai-code-worker-${idA.toLowerCase()}.txt') ? 0 : 1)"`],
        concurrencyKeys: [`${idA.toLowerCase()}-key`],
        risk: "low"
      },
      {
        id: idB,
        kind: "backend",
        role: "phase2-parallel-worker",
        dependsOn: [],
        requiredInputs: ["README.md"],
        allowedPaths: [`src/${idB.toLowerCase()}/**`],
        forbiddenPaths: [".git/**"],
        expectedArtifacts: [],
        acceptanceCriteria: [`${idB} writes its output file.`],
        verify: [`node -e "process.exit(require('fs').existsSync('src/${idB.toLowerCase()}/ai-code-worker-${idB.toLowerCase()}.txt') ? 0 : 1)"`],
        concurrencyKeys: [`${idB.toLowerCase()}-key`],
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

function incompatiblePlanBody(): unknown {
  return {
    goal: "Two tasks whose allowedPaths overlap must never dispatch in the same wave.",
    tasks: [
      {
        id: "TASK-C",
        kind: "backend",
        role: "phase2-parallel-worker",
        dependsOn: [],
        requiredInputs: ["README.md"],
        allowedPaths: ["src/shared/**"],
        forbiddenPaths: [".git/**"],
        expectedArtifacts: [],
        acceptanceCriteria: ["TASK-C writes its output file."],
        verify: [`node -e "process.exit(require('fs').existsSync('src/shared/ai-code-worker-task-c.txt') ? 0 : 1)"`],
        concurrencyKeys: [],
        risk: "low"
      },
      {
        id: "TASK-D",
        kind: "backend",
        role: "phase2-parallel-worker",
        dependsOn: [],
        requiredInputs: ["README.md"],
        allowedPaths: ["src/shared/**"],
        forbiddenPaths: [".git/**"],
        expectedArtifacts: [],
        acceptanceCriteria: ["TASK-D writes its output file."],
        verify: [`node -e "process.exit(require('fs').existsSync('src/shared/ai-code-worker-task-d.txt') ? 0 : 1)"`],
        concurrencyKeys: [],
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
