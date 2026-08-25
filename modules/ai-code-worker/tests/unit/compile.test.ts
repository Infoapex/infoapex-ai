import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { after, describe, it } from "node:test";
import { runCompile } from "../../src/compile/compile.js";
import { freezeManifest } from "../../src/manifest/normalize.js";
import { EventLog } from "../../src/persistence/event-log.js";
import { runStatus } from "../../src/status/status.js";
import { resolveStateRoot } from "../../src/state/state-root.js";

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

describe("compile command", () => {
  it("compiles an accepted plan into external state and authorization", () => {
    const repo = createGitRepository();
    writePlan(repo, "Plan/ACCEPTED.md", "accepted");
    const beforeFiles = listRepositoryFiles(repo);
    const report = runCompile({
      repositoryPath: repo,
      planPath: "Plan/ACCEPTED.md",
      runId: "run-compile-1",
      now: "2026-08-01T10:00:00Z"
    });

    assert.equal(report.status, "PASS");
    assert.equal(report.runId, "run-compile-1");
    assert.ok(report.state.runRoot);
    assert.equal(report.state.runRoot?.startsWith(repo), false);
    assert.deepEqual(listRepositoryFiles(repo), beforeFiles);

    const manifest = JSON.parse(readFileSync(report.state.manifestPath!, "utf8"));
    const authorization = JSON.parse(readFileSync(report.state.authorizationPath!, "utf8"));
    const events = new EventLog(report.state.eventLogPath!).read().events;
    const status = runStatus({
      repositoryPath: repo,
      runId: "run-compile-1",
      now: "2026-08-01T10:01:00Z"
    });

    assert.equal(report.manifestSha256, freezeManifest(manifest).sha256);
    assert.equal(authorization.manifestSha256, report.manifestSha256);
    assert.deepEqual(
      events.map((event) => event.type),
      ["run.created", "run.intent-created", "manifest.compiled", "manifest.frozen", "authorization.bound"]
    );
    assert.equal(status.run.status, "AUTHORIZED");
  });

  it("blocks proposed plans before writing run state", () => {
    const repo = createGitRepository();
    writePlan(repo, "Plan/PROPOSED.md", "proposed");
    const stateRoot = resolveStateRoot({ repoRoot: repo }).path;
    stateRoots.push(stateRoot);
    rmSync(stateRoot, { recursive: true, force: true });

    const report = runCompile({
      repositoryPath: repo,
      planPath: "Plan/PROPOSED.md",
      runId: "run-proposed",
      now: "2026-08-01T10:00:00Z"
    });

    assert.equal(report.status, "BLOCKED");
    assert.equal(report.findings[0]?.code, "PLAN_NOT_ACCEPTED");
    assert.equal(existsSync(join(stateRoot, "runs", "run-proposed")), false);
  });

  it("returns existing frozen run state without appending duplicate compile events", () => {
    const repo = createGitRepository();
    writePlan(repo, "Plan/ACCEPTED.md", "accepted");
    const first = runCompile({
      repositoryPath: repo,
      planPath: "Plan/ACCEPTED.md",
      runId: "run-idempotent",
      now: "2026-08-01T10:00:00Z"
    });
    const second = runCompile({
      repositoryPath: repo,
      planPath: "Plan/ACCEPTED.md",
      runId: "run-idempotent",
      now: "2026-08-01T10:05:00Z"
    });
    const events = new EventLog(first.state.eventLogPath!).read().events;

    assert.equal(second.status, "PASS");
    assert.equal(second.manifestSha256, first.manifestSha256);
    assert.equal(events.length, 5);
  });

  it("exposes compile as a JSON CLI command", () => {
    const repo = createGitRepository();
    writePlan(repo, "Plan/ACCEPTED.md", "accepted");
    const output = execFileSync(
      process.execPath,
      [resolve("dist/src/cli.js"), "compile", "--repo", repo, "--plan", "Plan/ACCEPTED.md", "--run-id", "run-cli", "--json"],
      { cwd: tmpdir(), encoding: "utf8" }
    );
    const report = JSON.parse(output) as { status: string; runId: string };

    assert.equal(report.status, "PASS");
    assert.equal(report.runId, "run-cli");
  });
});

function createGitRepository(): string {
  const repo = mkdtempSync(join(tmpdir(), "aicw-compile-"));
  tempRepos.push(repo);
  stateRoots.push(resolveStateRoot({ repoRoot: repo }).path);

  execFileSync("git", ["init"], { cwd: repo, stdio: "ignore" });
  writeFileSync(join(repo, "README.md"), "# fixture\n");
  execFileSync("git", ["add", "README.md"], { cwd: repo, stdio: "ignore" });
  execFileSync("git", ["-c", "user.name=ai-code-worker", "-c", "user.email=worker@example.test", "commit", "-m", "init"], {
    cwd: repo,
    stdio: "ignore"
  });

  return repo;
}

function writePlan(repo: string, path: string, status: "accepted" | "proposed"): void {
  const fullPath = join(repo, ...path.split("/"));
  execFileSync("git", ["checkout", "-B", "main"], { cwd: repo, stdio: "ignore" });
  mkdirSync(dirname(fullPath), { recursive: true });
  writeFileSync(
    fullPath,
    `---\nstatus: ${status}\n---\n\n# Test plan\n\n\`\`\`json ai-code-worker-plan\n${JSON.stringify(planBody(), null, 2)}\n\`\`\`\n`,
    "utf8"
  );
}

function planBody(): unknown {
  return {
    goal: "Compile a deterministic Phase 0 fixture.",
    tasks: [
      {
        id: "T1",
        kind: "test",
        role: "phase0-worker",
        dependsOn: [],
        requiredInputs: ["README.md"],
        allowedPaths: ["src/**"],
        forbiddenPaths: [".git/**"],
        expectedArtifacts: ["dist/src/cli.js"],
        acceptanceCriteria: ["Compile writes manifest and authorization outside the repository."],
        verify: ["npm test"],
        concurrencyKeys: ["compile"],
        risk: "low"
      }
    ],
    globalGates: ["npm test"],
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
      onUnknownUsage: "block"
    }
  };
}

function listRepositoryFiles(repo: string): string[] {
  return readdirSync(repo, { recursive: true })
    .map((entry) => String(entry).replaceAll("\\", "/"))
    .filter((entry) => !entry.startsWith(".git/") && entry !== ".git")
    .sort();
}
