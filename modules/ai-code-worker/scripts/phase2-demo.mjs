import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const cli = join(root, "dist", "src", "cli.js");

run("npm", ["run", "build"], root);

const { writeFakeClaudeCli } = await import(`file://${join(root, "dist", "src", "engines", "claude-cli.js")}`);
const { runClaude } = await import(`file://${join(root, "dist", "src", "run", "claude-run.js")}`);

const repo = createFixtureRepository();

const doctorClaude = runJson(cli, ["doctor", "--repo", repo, "--engine", "claude", "--json"]);
const parallelCompatible = runJson(cli, [
  "run",
  "--engine",
  "fake",
  "--repo",
  repo,
  "--plan",
  "Plan/PARALLEL-COMPATIBLE.md",
  "--run-id",
  "run-phase2-parallel-compatible",
  "--json"
]);
const parallelIncompatible = runJson(cli, [
  "run",
  "--engine",
  "fake",
  "--repo",
  repo,
  "--plan",
  "Plan/PARALLEL-INCOMPATIBLE.md",
  "--run-id",
  "run-phase2-parallel-incompatible",
  "--json"
]);

// `run --engine claude` against a fake Claude CLI fixture: the compiled CLI binary does
// not (yet) expose a flag to point the Claude adapter at a fixture executable, so this
// leg calls runClaude() directly with an adapterConfig override - the same mechanism
// tests/unit/claude-run.test.ts uses. Wiring an equivalent `--claude-executable` CLI
// flag is left as follow-up (see docs/PHASE-2.md).
const fakeClaudeCliDir = mkdtempSync(join(tmpdir(), "aicw-phase2-demo-claude-cli-"));
const fakeClaudeCliPath = join(fakeClaudeCliDir, "claude-fake.mjs");
writeFakeClaudeCli(fakeClaudeCliPath, { version: "2.1.177", touchedFile: "src/claude-demo/ai-code-worker-claude-demo.txt" });
chmodSync(fakeClaudeCliPath, 0o755);

const claudeRun = runClaude({
  repositoryPath: repo,
  planPath: "Plan/CLAUDE-DEMO.md",
  runId: "run-phase2-claude-demo",
  adapterConfig: {
    executable: process.execPath,
    baseArgs: [fakeClaudeCliPath],
    testedVersionRanges: ["2.1.177"],
    requiresCapabilitySmokeTest: true
  }
});

console.log(
  JSON.stringify(
    {
      fixtureRepository: repo,
      doctorClaude: doctorClaude.status,
      claudeRunStatus: claudeRun.status,
      claudeRunExecutedTasks: claudeRun.executedTasks,
      parallelCompatibleStatus: parallelCompatible.status,
      parallelCompatibleTasks: parallelCompatible.executedTasks,
      parallelIncompatibleStatus: parallelIncompatible.status,
      parallelIncompatibleTasks: parallelIncompatible.executedTasks
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
  const repo = mkdtempSync(join(tmpdir(), "aicw-phase2-demo-"));

  mkdirSync(join(repo, "Plan"), { recursive: true });
  writeFileSync(join(repo, "README.md"), "# Phase 2 fixture\n", "utf8");
  writeFileSync(join(repo, "Plan", "CLAUDE-DEMO.md"), acceptedPlan(claudeDemoPlanBody()), "utf8");
  writeFileSync(join(repo, "Plan", "PARALLEL-COMPATIBLE.md"), acceptedPlan(parallelCompatiblePlanBody()), "utf8");
  writeFileSync(join(repo, "Plan", "PARALLEL-INCOMPATIBLE.md"), acceptedPlan(parallelIncompatiblePlanBody()), "utf8");
  execFileSync("git", ["init"], { cwd: repo, stdio: "ignore" });
  execFileSync("git", ["add", "README.md", "Plan"], { cwd: repo, stdio: "ignore" });
  execFileSync("git", ["-c", "user.name=ai-code-worker", "-c", "user.email=worker@example.test", "commit", "-m", "phase2 fixture"], {
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

function acceptedPlan(body) {
  return `---
status: accepted
---

# Phase 2 demo plan

\`\`\`json ai-code-worker-plan
${JSON.stringify(body, null, 2)}
\`\`\`
`;
}

function claudeDemoPlanBody() {
  return {
    goal: "Demonstrate run --engine claude against a fake Claude CLI fixture.",
    tasks: [
      {
        id: "CLAUDE-DEMO-01",
        kind: "backend",
        role: "phase2-claude-worker",
        dependsOn: [],
        requiredInputs: ["README.md"],
        allowedPaths: ["src/claude-demo/**"],
        forbiddenPaths: [".git/**"],
        expectedArtifacts: ["src/claude-demo/ai-code-worker-claude-demo.txt"],
        acceptanceCriteria: ["Claude writes the expected output file."],
        verify: ['node -e "process.exit(require(\'fs\').existsSync(\'src/claude-demo/ai-code-worker-claude-demo.txt\') ? 0 : 1)"'],
        concurrencyKeys: ["claude-demo"],
        risk: "low"
      }
    ],
    globalGates: [],
    budgets: budgets(1)
  };
}

function parallelCompatiblePlanBody() {
  return {
    goal: "Two independent tasks dispatch in one wave and integrate deterministically.",
    tasks: [
      parallelTask("PARALLEL-A", "a-key"),
      parallelTask("PARALLEL-B", "b-key")
    ],
    globalGates: [],
    budgets: budgets(2)
  };
}

function parallelIncompatiblePlanBody() {
  return {
    goal: "Two tasks with overlapping allowedPaths must never dispatch in the same wave.",
    tasks: [
      parallelTask("PARALLEL-C", "shared-key", "src/shared"),
      parallelTask("PARALLEL-D", "shared-key", "src/shared")
    ],
    globalGates: [],
    budgets: budgets(2)
  };
}

function parallelTask(id, key, pathPrefix) {
  const lower = id.toLowerCase();
  const prefix = pathPrefix ?? `src/${lower}`;
  return {
    id,
    kind: "backend",
    role: "phase2-parallel-worker",
    dependsOn: [],
    requiredInputs: ["README.md"],
    allowedPaths: [`${prefix}/**`],
    forbiddenPaths: [".git/**"],
    expectedArtifacts: [],
    acceptanceCriteria: [`${id} writes its output file.`],
    verify: [`node -e "process.exit(require('fs').existsSync('${prefix}/ai-code-worker-${lower}.txt') ? 0 : 1)"`],
    concurrencyKeys: [key],
    risk: "low"
  };
}

function budgets(maximumParallelWriters) {
  return {
    maximumParallelWriters,
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
  };
}
