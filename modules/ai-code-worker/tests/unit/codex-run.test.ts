import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { after, describe, it } from "node:test";
import { writeFakeCodexCli } from "../../src/engines/codex-cli.js";
import { runCodex } from "../../src/run/codex-run.js";
import { SchemaRegistry } from "../../src/schema/json-schema.js";
import { resolveStateRoot } from "../../src/state/state-root.js";
import { FakeExecutionEnvironment } from "../../src/execution/environment.js";
import type { ContextPackage } from "../../src/context-provider/types.js";

const tempRepos: string[] = [];
const stateRoots: string[] = [];
const tempRoots: string[] = [];
const registry = SchemaRegistry.load({ schemaDirectory: "schemas" });
// Isolates report/run-report.ts's real-quota lookup (findLatestCodexRolloutPath)
// from whatever real Codex rollout history happens to exist on the machine running
// these tests - an empty directory always yields "no rollout found", the correct,
// deterministic "unknown quota" outcome for a fake-CLI test double.
const emptyCodexSessionsDir = mkdtempSync(join(tmpdir(), "aicw-empty-codex-sessions-"));
tempRoots.push(emptyCodexSessionsDir);

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

describe("codex run coordinator", () => {
  it("executes the real trusted-host path with a test CLI and records the honest boundary", async () => {
    const repo = createGitRepository();
    const executionProfile = readFileSync("templates/project/.ai-code-worker/execution-environment.trusted-host.example.json", "utf8");
    mkdirSync(join(repo, ".ai-code-worker"), { recursive: true });
    writeFileSync(join(repo, ".ai-code-worker", "execution-environment.example.json"), executionProfile);
    execFileSync("git", ["add", ".ai-code-worker/execution-environment.example.json"], { cwd: repo });
    execFileSync("git", ["-c", "user.name=ai-code-worker", "-c", "user.email=worker@example.test", "commit", "-m", "Explicit trusted host fixture"], { cwd: repo, stdio: "ignore" });
    const cli = fakeCli("0.146.0-alpha.3.1", "src/codex-output.txt");
    const report = await runCodex({
      repositoryPath: repo, codexSessionsDir: emptyCodexSessionsDir,
      planPath: "Plan/RUN.md", runId: "run-trusted-host",
      now: "2026-08-01T10:00:00Z",
      adapterConfig: { executable: process.execPath, baseArgs: [cli], testedVersionRanges: ["0.146.0-alpha.3.1"], requiresCapabilitySmokeTest: true }
    });
    assert.equal(report.status, "DONE", JSON.stringify(report.findings));
    const evidence = JSON.parse(readFileSync(report.state.runEvidencePath!, "utf8"));
    assert.equal(evidence.executionEnvironment.backend, "trusted-host");
    assert.equal(evidence.executionEnvironment.securityBoundary, "host-process");
  });

  it("executes a single-writer codex run through worktree, commit, gates, review, and report", async () => {
    const repo = createGitRepository();
    const beforeFiles = listRepositoryFiles(repo);
    const cli = fakeCli("0.146.0-alpha.3.1", "src/codex-output.txt");
    const report = await runCodex({
      repositoryPath: repo,
      executionEnvironment: new FakeExecutionEnvironment(),
      codexSessionsDir: emptyCodexSessionsDir,
      planPath: "Plan/RUN.md",
      runId: "run-codex",
      now: "2026-08-01T10:00:00Z",
      adapterConfig: {
        executable: process.execPath,
        baseArgs: [cli],
        testedVersionRanges: ["0.146.0-alpha.3.1"],
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

    assert.equal(agentResult.runId, "run-codex");
    assert.equal(agentResult.taskId, "TASK-01");
    assert.deepEqual(registry.validate("agent-result.schema.json", agentResult), { valid: true, errors: [] });
    assert.deepEqual(registry.validate("evidence.schema.json", evidence), { valid: true, errors: [] });
    assert.deepEqual(registry.validate("evidence.schema.json", runEvidence), { valid: true, errors: [] });
    assert.equal(evidence.executionEnvironment.profileId, "isolated");
    assert.equal(evidence.executionEnvironment.backend, "fake-isolated");
    assert.equal(evidence.executionEnvironment.securityBoundary, "simulated");
    assert.match(evidence.executionEnvironment.profileSha256, /^[a-f0-9]{64}$/);
    assert.deepEqual(runEvidence.executionEnvironment, evidence.executionEnvironment);
    assert.equal(runReport.status, "DONE");
    assert.equal(runReport.engine, "codex");
    assert.equal(runReport.review.status, "PASS");
    assert.deepEqual(runReport.taskCommits, report.taskCommits);
  });

  it("honors testedVersionRanges from .ai-code-worker/config.json (previously dead config)", async () => {
    const repo = createGitRepository();
    mkdirSync(join(repo, ".ai-code-worker"), { recursive: true });
    writeFileSync(
      join(repo, ".ai-code-worker", "config.json"),
      JSON.stringify({ schemaVersion: "1.0", adapters: { codex: { testedVersionRanges: ["9.9.9-project-configured"] } } }),
      "utf8"
    );
    const cli = fakeCli("9.9.9-project-configured", "src/codex-output.txt");

    const report = await runCodex({
      repositoryPath: repo,
      executionEnvironment: new FakeExecutionEnvironment(),
      codexSessionsDir: emptyCodexSessionsDir,
      planPath: "Plan/RUN.md",
      runId: "run-codex-project-config",
      now: "2026-08-01T10:00:00Z",
      adapterConfig: {
        executable: process.execPath,
        baseArgs: [cli],
        requiresCapabilitySmokeTest: true
        // deliberately no testedVersionRanges here - only the project config supplies it
      }
    });

    assert.equal(report.status, "DONE");
  });

  it("enforce mode binds the exact context digest to the engine prompt and event log", async () => {
    const repo = createGitRepository();
    const captureRoot = mkdtempSync(join(tmpdir(), "aicw-context-prompt-"));
    tempRoots.push(captureRoot);
    const capturePath = join(captureRoot, "prompt.json");
    const cli = fakeCli("0.146.0-alpha.3.1", "src/codex-output.txt", capturePath);
    const contextPackage = packageFor("run-codex-context", "TASK-01");

    const report = await runCodex({
      repositoryPath: repo,
      executionEnvironment: new FakeExecutionEnvironment(),
      codexSessionsDir: emptyCodexSessionsDir,
      planPath: "Plan/RUN.md",
      runId: "run-codex-context",
      now: "2026-08-01T10:00:00Z",
      taskContextPackages: { "TASK-01": contextPackage },
      contextPackageMode: "enforce",
      adapterConfig: {
        executable: process.execPath,
        baseArgs: [cli],
        testedVersionRanges: ["0.146.0-alpha.3.1"],
        requiresCapabilitySmokeTest: true
      }
    });

    assert.equal(report.status, "DONE");
    const prompt = JSON.parse(readFileSync(capturePath, "utf8"));
    assert.equal(prompt.contextPackage.contextDigest, contextPackage.contextDigest);
    assert.equal("contextProviderContext" in prompt, false);
    const events = readFileSync(report.state.eventLogPath!, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    const linked = events.find((event) => event.type === "task.context-compiled");
    assert.equal(linked?.payload.contextDigest, contextPackage.contextDigest);
    assert.equal(linked?.payload.consumedByEngine, true);
    const snapshot = JSON.parse(
      readFileSync(join(report.state.runRoot!, "tasks", "TASK-01", "task-input.json"), "utf8")
    );
    assert.equal(snapshot.contextDigest, contextPackage.contextDigest);
    assert.equal(snapshot.contextCompilerVersion, contextPackage.compilerVersion);
  });
});

function createGitRepository(): string {
  const repo = mkdtempSync(join(tmpdir(), "aicw-codex-run-"));
  tempRepos.push(repo);
  stateRoots.push(resolveStateRoot({ repoRoot: repo }).path);

  mkdirSync(join(repo, "Plan"), { recursive: true });
  writeFileSync(join(repo, "README.md"), "# fixture\n", "utf8");
  writeFileSync(join(repo, "Plan", "RUN.md"), acceptedPlan(), "utf8");
  execFileSync("git", ["init"], { cwd: repo, stdio: "ignore" });
  execFileSync("git", ["add", "README.md", "Plan/RUN.md"], { cwd: repo, stdio: "ignore" });
  execFileSync("git", ["-c", "user.name=ai-code-worker", "-c", "user.email=worker@example.test", "commit", "-m", "codex run fixture"], {
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

function fakeCli(version: string, touchedFile: string, capturePromptPath?: string): string {
  const root = mkdtempSync(join(tmpdir(), "aicw-fake-codex-run-"));
  tempRoots.push(root);
  const cli = join(root, "codex-fake.mjs");
  writeFakeCodexCli(cli, { version, touchedFile, capturePromptPath });
  chmodSync(cli, 0o755);
  return cli;
}

function packageFor(runId: string, taskId: string): ContextPackage {
  return {
    schemaVersion: "1.0",
    packageId: "ctx-codex-test",
    runId,
    taskId,
    manifestSha256: "a".repeat(64),
    compilerVersion: "1.0.0",
    sources: [],
    budget: {
      measurement: "characters-fallback",
      maximumTokens: 1000,
      estimatedTokens: 0,
      maximumCharacters: 4000,
      estimatedCharacters: 0,
      omittedSources: []
    },
    diagnostics: [],
    contextDigest: "c".repeat(64),
    createdAt: "2026-08-01T10:00:00Z"
  };
}

function acceptedPlan(): string {
  return `---
status: accepted
---

# Codex run plan

\`\`\`json ai-code-worker-plan
${JSON.stringify(planBody(), null, 2)}
\`\`\`
`;
}

function planBody(): unknown {
  return {
    goal: "Execute a Codex-backed single-writer task.",
    tasks: [
      {
        id: "TASK-01",
        kind: "backend",
        role: "phase1-codex-worker",
        dependsOn: [],
        requiredInputs: ["README.md"],
        allowedPaths: ["src/**"],
        forbiddenPaths: [".git/**"],
        expectedArtifacts: ["src/codex-output.txt"],
        acceptanceCriteria: ["Codex writes the expected output file."],
        verify: ['node -e "process.exit(require(\'fs\').existsSync(\'src/codex-output.txt\') ? 0 : 1)"'],
        concurrencyKeys: ["codex-run"],
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
