import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repo = createFixtureRepository();
const cli = join(root, "dist", "src", "cli.js");

run("npm", ["run", "build"], root);

const doctor = runJson(cli, ["doctor", "--repo", repo, "--json"]);
const compile = runJson(cli, ["compile", "--repo", repo, "--plan", "Plan/PHASE-0-DEMO.md", "--json"]);
const fakeRun = runJson(cli, ["run", "--engine", "fake", "--repo", repo, "--plan", "Plan/PHASE-0-DEMO.md", "--run-id", "run-phase0-demo", "--json"]);
const status = runJson(cli, ["status", "--repo", repo, "--run-id", compile.runId, "--json"]);
const fakeRunStatus = runJson(cli, ["status", "--repo", repo, "--run-id", fakeRun.runId, "--json"]);

console.log(
  JSON.stringify(
    {
      fixtureRepository: repo,
      doctor: doctor.status,
      compile: compile.status,
      runId: compile.runId,
      manifestSha256: compile.manifestSha256,
      status: status.run.status,
      fakeRun: fakeRun.status,
      fakeRunId: fakeRun.runId,
      fakeRunTasks: fakeRun.executedTasks,
      fakeRunTaskCommits: fakeRun.taskCommits,
      fakeRunStatus: fakeRunStatus.run.status,
      stateRoot: compile.state.runRoot
    },
    null,
    2
  )
);

function runJson(file, args) {
  return JSON.parse(execFileSync(process.execPath, [file, ...args], { cwd: root, encoding: "utf8" }));
}

function run(file, args, cwd) {
  const result = spawnSync(file, args, {
    cwd,
    shell: process.platform === "win32",
    stdio: "inherit"
  });

  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

function createFixtureRepository() {
  const repo = mkdtempSync(join(tmpdir(), "aicw-phase0-demo-"));

  mkdirSync(join(repo, "Plan"), { recursive: true });
  writeFileSync(join(repo, "README.md"), "# Phase 0 fixture\n", "utf8");
  writeFileSync(join(repo, "Plan", "PHASE-0-DEMO.md"), acceptedPlan(), "utf8");
  execFileSync("git", ["init"], { cwd: repo, stdio: "ignore" });
  execFileSync("git", ["add", "README.md", "Plan/PHASE-0-DEMO.md"], { cwd: repo, stdio: "ignore" });
  execFileSync("git", ["-c", "user.name=ai-code-worker", "-c", "user.email=worker@example.test", "commit", "-m", "phase0 fixture"], {
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

function acceptedPlan() {
  return `---
status: accepted
---

# Phase 0 demo plan

\`\`\`json ai-code-worker-plan
${JSON.stringify(planBody(), null, 2)}
\`\`\`
`;
}

function planBody() {
  return {
    goal: "Demonstrate deterministic Phase 0 compile and status replay.",
    tasks: [
      {
        id: "CONTRACT-01",
        kind: "contract",
        role: "phase0-worker",
        dependsOn: [],
        requiredInputs: ["README.md"],
        allowedPaths: ["schemas/**"],
        forbiddenPaths: [".git/**"],
        expectedArtifacts: ["dist/src/cli.js"],
        acceptanceCriteria: ["The accepted plan compiles without mutating the fixture repository."],
        verify: ['node -e "process.exit(0)"'],
        concurrencyKeys: ["phase0-demo"],
        risk: "low"
      },
      {
        id: "STATUS-01",
        kind: "test",
        role: "phase0-worker",
        dependsOn: ["CONTRACT-01"],
        requiredInputs: ["Plan/PHASE-0-DEMO.md"],
        allowedPaths: ["src/**", "tests/**"],
        forbiddenPaths: [".git/**"],
        expectedArtifacts: ["dist/src/cli.js"],
        acceptanceCriteria: ["Status replay reports AUTHORIZED after compile."],
        verify: ['node -e "process.exit(0)"'],
        concurrencyKeys: ["phase0-demo"],
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
