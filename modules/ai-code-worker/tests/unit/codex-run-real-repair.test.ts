import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { after, describe, it } from "node:test";
import { writeFakeCodexCli } from "../../src/engines/codex-cli.js";
import { runCodex } from "../../src/run/codex-run.js";
import { createCodexRepairExecutor } from "../../src/repair/execute-codex-repair-cycle.js";
import { resolveStateRoot } from "../../src/state/state-root.js";
import type { IndependentReviewResult } from "../../src/review/independent-review.js";

/**
 * Lighter than claude-run-real-repair.test.ts: createRealEngineRepairExecutor
 * (the shared worktree -> engine -> commit -> real-verify -> re-review core)
 * is already proven there. This file exists only to catch a codex-run.ts-
 * specific wiring bug (the integration step and the executeRepairCycle
 * factory type were separate edits, not shared code) - one positive case is
 * enough for that.
 */

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

function reviewWithFinding(runId: string): IndependentReviewResult {
  return {
    schemaVersion: "1.0",
    runId,
    reviewId: "review-1",
    reviewer: "fake-reviewer",
    graphVersion: 1,
    createdAt: "2026-08-16T09:00:00Z",
    verdict: "fail",
    criterionCoverage: [
      { criterionId: "AC-01", verdict: "contradicted", tests: [], commands: ["node -e \"process.exit(require('fs').existsSync('target.txt') ? 0 : 1)\""], evidence: "target.txt was never written" }
    ],
    findings: [
      {
        id: "REV-001",
        severity: "blocking",
        category: "correctness",
        criterionIds: ["AC-01"],
        files: ["target.txt"],
        evidence: "target.txt is required by AC-01 but does not exist."
      }
    ]
  };
}

function reviewClean(runId: string): IndependentReviewResult {
  return { ...reviewWithFinding(runId), verdict: "pass", findings: [] };
}

function fakeCli(version: string, touchedFile: string | null): string {
  const root = mkdtempSync(join(tmpdir(), "aicw-fake-codex-repair-"));
  tempRoots.push(root);
  const cli = join(root, "codex-fake.mjs");
  writeFakeCodexCli(cli, { version, ...(touchedFile ? { touchedFile } : {}) });
  chmodSync(cli, 0o755);
  return cli;
}

function createReviewFailingRepository(): string {
  const repo = mkdtempSync(join(tmpdir(), "aicw-codex-real-repair-"));
  tempRepos.push(repo);
  stateRoots.push(resolveStateRoot({ repoRoot: repo }).path);

  mkdirSync(join(repo, "Plan"), { recursive: true });
  mkdirSync(join(repo, ".ai-code-worker"), { recursive: true });
  writeFileSync(join(repo, "README.md"), "# fixture\n", "utf8");
  writeFileSync(
    join(repo, ".ai-code-worker", "config.json"),
    JSON.stringify({
      schemaVersion: "1.0",
      executionEnvironment: { defaultProfile: "trusted-local", allowTrustedLocal: true }
    }),
    "utf8"
  );
  writeFileSync(
    join(repo, ".ai-code-worker", "execution-environment.example.json"),
    readFileSync("templates/project/.ai-code-worker/execution-environment.trusted-local.example.json", "utf8"),
    "utf8"
  );
  writeFileSync(
    join(repo, "Plan", "RUN.md"),
    `---
status: accepted
---

# Codex real-repair fixture plan

\`\`\`json ai-code-worker-plan
${JSON.stringify(
  {
    goal: "Execute a Codex-backed task whose review fails structurally, then repair it for real.",
    tasks: [
      {
        id: "CONTRACT-01",
        kind: "contract",
        role: "phase3-codex-worker",
        dependsOn: [],
        requiredInputs: ["README.md"],
        allowedPaths: ["src/**"],
        forbiddenPaths: [".git/**"],
        expectedArtifacts: [],
        acceptanceCriteria: ["Contract task has no verify command, so structural review always fails."],
        verify: [],
        concurrencyKeys: ["codex-real-repair"],
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
  execFileSync("git", ["-c", "user.name=ai-code-worker", "-c", "user.email=worker@example.test", "commit", "-m", "codex real-repair fixture"], {
    cwd: repo,
    env: { ...process.env, GIT_AUTHOR_DATE: "2026-08-16T09:00:00Z", GIT_COMMITTER_DATE: "2026-08-16T09:00:00Z" },
    stdio: "ignore"
  });

  return repo;
}

describe("codex run coordinator - real engine repair (todo.md #13, real-engine slice)", () => {
  it("dispatches a real (fake-CLI) Codex repair attempt that writes the missing file, and verify decides DONE for real", () => {
    const repo = createReviewFailingRepository();
    const stateRoot = resolveStateRoot({ repoRoot: repo }).path;
    const runId = "run-codex-real-repair-pass";
    const taskCli = fakeCli("0.146.0-alpha.3.1", "src/original-output.txt");
    const repairCli = fakeCli("0.146.0-alpha.3.1", "target.txt");

    const report = runCodex({
      repositoryPath: repo,
      planPath: "Plan/RUN.md",
      runId,
      now: "2026-08-16T09:05:00Z",
      trustedLocalAuthorization: trustedLocalAuthorization(),
      adapterConfig: {
        executable: process.execPath,
        baseArgs: [taskCli],
        testedVersionRanges: ["0.146.0-alpha.3.1"],
        requiresCapabilitySmokeTest: true
      },
      independentReview: {
        reviewer: ({ runId: reviewedRunId }) => reviewWithFinding(reviewedRunId),
        executeRepairCycle: (repairBaseCommit, execution) =>
          createCodexRepairExecutor({
            repositoryPath: repo,
            stateRoot,
            runId,
            manifestSha256: "0".repeat(64),
            baseCommit: repairBaseCommit,
            adapterConfig: {
              executable: process.execPath,
              baseArgs: [repairCli],
              testedVersionRanges: ["0.146.0-alpha.3.1"],
              requiresCapabilitySmokeTest: true,
              execution
            },
            reviewer: ({ runId: reviewedRunId }) => reviewClean(reviewedRunId)
          })
      }
    });

    assert.equal(report.status, "DONE");

    const repairTaskIds = Object.keys(report.taskCommits).filter((id) => id.startsWith("REPAIR-"));
    assert.equal(repairTaskIds.length, 1);
    const repairCommit = report.taskCommits[repairTaskIds[0]!]!;
    const committedContent = execFileSync("git", ["show", `${repairCommit}:target.txt`], { cwd: repo, encoding: "utf8" });
    assert.match(committedContent, /codex fake output|fake output/i);
    assert.equal(existsSync(join(repo, "target.txt")), false);
  });
});

function trustedLocalAuthorization() {
  return {
    approved: true as const,
    authorizedBy: "external-repair-test-controller",
    reason: "Explicit trusted-local real repair fixture",
    approvedAt: "2026-08-26T09:00:00.000Z",
    source: "api" as const
  };
}
