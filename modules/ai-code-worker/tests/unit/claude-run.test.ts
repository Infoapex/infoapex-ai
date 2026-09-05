import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { after, describe, it } from "node:test";
import { writeFakeClaudeCli } from "../../src/engines/claude-cli.js";
import { runClaude } from "../../src/run/claude-run.js";
import { SchemaRegistry } from "../../src/schema/json-schema.js";
import { resolveStateRoot } from "../../src/state/state-root.js";

const tempRepos: string[] = [];
const stateRoots: string[] = [];
const tempRoots: string[] = [];
const registry = SchemaRegistry.load({ schemaDirectory: "schemas" });

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

describe("claude run coordinator", () => {
  it("executes a single-writer claude run through worktree, commit, gates, review, and report", async () => {
    const repo = createGitRepository();
    const beforeFiles = listRepositoryFiles(repo);
    const cli = fakeCli("2.1.177", "src/claude-output.txt");
    const report = await runClaude({
      repositoryPath: repo,
      planPath: "Plan/RUN.md",
      runId: "run-claude",
      now: "2026-08-01T10:00:00Z",
      adapterConfig: {
        executable: process.execPath,
        baseArgs: [cli],
        testedVersionRanges: ["2.1.177"],
        requiresCapabilitySmokeTest: true
      }
    });

    assert.equal(report.status, "DONE");
    assert.deepEqual(report.executedTasks, ["TASK-01"]);
    assert.match(report.taskCommits["TASK-01"]!, /^[a-f0-9]{40}$/);
    assert.deepEqual(listRepositoryFiles(repo), beforeFiles);

    const taskRoot = join(report.state.runRoot!, "tasks", "TASK-01");
    const agentResult = JSON.parse(readFileSync(join(taskRoot, "agent-result.json"), "utf8"));
    const evidence = JSON.parse(readFileSync(join(taskRoot, "evidence.json"), "utf8"));
    const runEvidence = JSON.parse(readFileSync(report.state.runEvidencePath!, "utf8"));
    const runReport = JSON.parse(readFileSync(join(report.state.runRoot!, "run-report.json"), "utf8"));
    const engineEvents = JSON.parse(readFileSync(join(taskRoot, "engine-events.json"), "utf8"));

    assert.equal(agentResult.runId, "run-claude");
    assert.equal(agentResult.taskId, "TASK-01");
    assert.deepEqual(registry.validate("agent-result.schema.json", agentResult), { valid: true, errors: [] });
    assert.deepEqual(registry.validate("evidence.schema.json", evidence), { valid: true, errors: [] });
    assert.deepEqual(registry.validate("evidence.schema.json", runEvidence), { valid: true, errors: [] });
    assert.equal(runReport.status, "DONE");
    assert.equal(runReport.engine, "claude");
    assert.equal(runReport.review.status, "PASS");
    assert.deepEqual(runReport.taskCommits, report.taskCommits);

    // No raw Claude transcript should ever be persisted - only the mapped engine
    // events and the schema-validated agent result.
    const taskFiles = readdirSync(taskRoot);
    assert.ok(!taskFiles.some((file) => file.includes("transcript") || file.includes("stdout")));
    for (const event of engineEvents) {
      assert.ok(["execution.started", "session.bound", "execution.completed", "execution.failed"].includes(event.type));
    }
  });

  it("fails closed and never commits when the Claude CLI is unavailable", async () => {
    const repo = createGitRepository();
    const beforeHead = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim();
    const report = await runClaude({
      repositoryPath: repo,
      planPath: "Plan/RUN.md",
      runId: "run-claude-missing",
      now: "2026-08-01T10:00:00Z",
      adapterConfig: {
        executable: join(tmpdir(), "no-such-claude-binary-xyz"),
        testedVersionRanges: ["2.1.x"],
        requiresCapabilitySmokeTest: true
      }
    });

    assert.equal(report.status, "BLOCKED");
    assert.deepEqual(report.executedTasks, []);
    assert.deepEqual(report.taskCommits, {});
    const afterHead = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim();
    assert.equal(afterHead, beforeHead);
  });
});

function createGitRepository(): string {
  const repo = mkdtempSync(join(tmpdir(), "aicw-claude-run-"));
  tempRepos.push(repo);
  stateRoots.push(resolveStateRoot({ repoRoot: repo }).path);

  mkdirSync(join(repo, "Plan"), { recursive: true });
  writeFileSync(join(repo, "README.md"), "# fixture\n", "utf8");
  writeFileSync(join(repo, "Plan", "RUN.md"), acceptedPlan(), "utf8");
  execFileSync("git", ["init"], { cwd: repo, stdio: "ignore" });
  execFileSync("git", ["add", "README.md", "Plan/RUN.md"], { cwd: repo, stdio: "ignore" });
  execFileSync("git", ["-c", "user.name=ai-code-worker", "-c", "user.email=worker@example.test", "commit", "-m", "claude run fixture"], {
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

function fakeCli(version: string, touchedFile: string): string {
  const root = mkdtempSync(join(tmpdir(), "aicw-fake-claude-run-"));
  tempRoots.push(root);
  const cli = join(root, "claude-fake.mjs");
  writeFakeClaudeCli(cli, { version, touchedFile });
  chmodSync(cli, 0o755);
  return cli;
}

function acceptedPlan(): string {
  return `---
status: accepted
---

# Claude run plan

\`\`\`json ai-code-worker-plan
${JSON.stringify(planBody(), null, 2)}
\`\`\`
`;
}

function planBody(): unknown {
  return {
    goal: "Execute a Claude-backed single-writer task.",
    tasks: [
      {
        id: "TASK-01",
        kind: "backend",
        role: "phase2-claude-worker",
        dependsOn: [],
        requiredInputs: ["README.md"],
        allowedPaths: ["src/**"],
        forbiddenPaths: [".git/**"],
        expectedArtifacts: ["src/claude-output.txt"],
        acceptanceCriteria: ["Claude writes the expected output file."],
        verify: ['node -e "process.exit(require(\'fs\').existsSync(\'src/claude-output.txt\') ? 0 : 1)"'],
        concurrencyKeys: ["claude-run"],
        risk: "low"
      }
    ],
    globalGates: ['node -e "process.exit(0)"'],
    budgets: {
      maximumParallelWriters: 1,
      maximumRepairCycles: 0,
      maximumTaskMinutes: 10,
      maximumRunMinutes: 30,
      maximumAgentInvocations: 1,
      maximumRunInputUncachedTokens: 100000,
      maximumRunCacheReadTokens: 100000,
      maximumRunCacheWriteTokens: 100000,
      maximumRunOutputTokens: 20000,
      maximumRunCostUsd: null,
      onUnknownUsage: "allow"
    }
  };
}

function listRepositoryFiles(repo: string): string[] {
  return readdirSync(repo, { recursive: true })
    .map((entry) => String(entry).replaceAll("\\", "/"))
    .filter((entry) => !entry.startsWith(".git/") && entry !== ".git")
    .sort();
}
