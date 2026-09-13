import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { runFake } from "../../src/run/fake-run.js";
import { createNoRepairCapabilityExecutor } from "../../src/review/no-repair-capability-executor.js";
import { createClaudeIndependentReviewer, createCodexIndependentReviewer } from "../../src/review/independent-reviewer-cli.js";
import { resolveStateRoot } from "../../src/state/state-root.js";

const tempDirs: string[] = [];
const stateRoots: string[] = [];

after(() => {
  for (const root of stateRoots) {
    rmSync(root, { recursive: true, force: true });
  }
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function reviewResultJson(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: "1.0",
    runId: "run-1",
    reviewId: "run-1-review-fixed",
    reviewer: "claude",
    graphVersion: 1,
    createdAt: "2026-08-15T10:00:00Z",
    verdict: "fail",
    criterionCoverage: [],
    findings: [
      {
        id: "REV-LIVE-001",
        severity: "blocking",
        category: "correctness",
        criterionIds: ["AC-01"],
        files: ["src/thing.ts"],
        evidence: "The diff does not add the required validation."
      }
    ],
    ...overrides
  };
}

describe("createClaudeIndependentReviewer", () => {
  it("returns a schema-valid review parsed from the CLI's JSON envelope", () => {
    const cli = fakeClaudeCli(JSON.stringify({ result: JSON.stringify(reviewResultJson()) }));
    const repo = createRepoWithOneCommit();
    const reviewer = createClaudeIndependentReviewer({
      repositoryPath: repo,
      baseCommit: headOf(repo),
      tasks: [{ id: "TASK-01", acceptanceCriteria: ["AC-01"] }],
      config: { executable: process.execPath, baseArgs: [cli] }
    });

    const result = reviewer({ runId: "run-1", graphVersion: 1, taskCommits: {} });

    assert.equal(result.verdict, "fail");
    assert.equal(result.findings[0]?.id, "REV-LIVE-001");
  });

  it("tolerates prose wrapped around the JSON object", () => {
    const wrapped = `Here is my review:\n${JSON.stringify(reviewResultJson())}\nEnd of review.`;
    const cli = fakeClaudeCli(JSON.stringify({ result: wrapped }));
    const repo = createRepoWithOneCommit();
    const reviewer = createClaudeIndependentReviewer({
      repositoryPath: repo,
      baseCommit: headOf(repo),
      tasks: [{ id: "TASK-01", acceptanceCriteria: [] }],
      config: { executable: process.execPath, baseArgs: [cli] }
    });

    const result = reviewer({ runId: "run-1", graphVersion: 1, taskCommits: {} });

    assert.equal(result.findings[0]?.id, "REV-LIVE-001");
  });

  it("fails closed with a blocking finding when the CLI produces invalid JSON", () => {
    const cli = fakeClaudeCli("not json at all");
    const repo = createRepoWithOneCommit();
    const reviewer = createClaudeIndependentReviewer({
      repositoryPath: repo,
      baseCommit: headOf(repo),
      tasks: [{ id: "TASK-01", acceptanceCriteria: [] }],
      config: { executable: process.execPath, baseArgs: [cli] },
      now: () => "2026-08-15T10:00:00Z"
    });

    const result = reviewer({ runId: "run-1", graphVersion: 1, taskCommits: {} });

    assert.equal(result.verdict, "fail");
    assert.equal(result.findings[0]?.id, "REV-ENGINE-FAILURE");
  });

  it("fails closed when the CLI exits non-zero", () => {
    const cli = fakeClaudeCliExitingNonZero();
    const repo = createRepoWithOneCommit();
    const reviewer = createClaudeIndependentReviewer({
      repositoryPath: repo,
      baseCommit: headOf(repo),
      tasks: [{ id: "TASK-01", acceptanceCriteria: [] }],
      config: { executable: process.execPath, baseArgs: [cli] },
      now: () => "2026-08-15T10:00:00Z"
    });

    const result = reviewer({ runId: "run-1", graphVersion: 1, taskCommits: {} });

    assert.equal(result.findings[0]?.id, "REV-ENGINE-FAILURE");
  });

  it("includes the real per-task diff in what would be sent as the prompt", () => {
    const repo = createRepoWithOneCommit();
    writeFileSync(join(repo, "src", "thing.ts"), "export const x = 2;\n", "utf8");
    execFileSync("git", ["add", "src/thing.ts"], { cwd: repo, stdio: "ignore" });
    execFileSync(
      "git",
      ["-c", "user.name=t", "-c", "user.email=t@example.test", "commit", "-m", "task change"],
      { cwd: repo, stdio: "ignore" }
    );
    const taskCommit = headOf(repo);
    const stdinCapturePath = join(mkdtempSync(join(tmpdir(), "aicw-reviewer-stdin-")), "stdin.txt");
    tempDirs.push(join(stdinCapturePath, ".."));
    const cli = fakeClaudeCliCapturingStdin(stdinCapturePath);
    const reviewer = createClaudeIndependentReviewer({
      repositoryPath: repo,
      baseCommit: firstCommit(repo),
      tasks: [{ id: "TASK-01", acceptanceCriteria: [] }],
      config: { executable: process.execPath, baseArgs: [cli] }
    });

    reviewer({ runId: "run-1", graphVersion: 1, taskCommits: { "TASK-01": taskCommit } });

    const captured = readFileSync(stdinCapturePath, "utf8");
    assert.match(captured, /export const x = 2;/);
  });
});

describe("createCodexIndependentReviewer", () => {
  it("fails closed when the provider boundary is unavailable", () => {
    const reviewer = createCodexIndependentReviewer({
      repositoryPath: ".",
      baseCommit: "HEAD",
      tasks: [],
      config: { processRunner: null },
      now: () => "2026-08-15T10:00:00Z"
    });

    const result = reviewer({ runId: "run-1", graphVersion: 1, taskCommits: {} });

    assert.equal(result.verdict, "fail");
    assert.equal(result.findings[0]?.id, "REV-ENGINE-FAILURE");
    assert.match(result.findings[0]?.evidence ?? "", /isolated Codex reviewer process runner/);
  });

  it("returns a schema-valid review parsed from the last agent_message JSONL event", () => {
    const cli = fakeCodexCli(
      [
        JSON.stringify({ type: "item.started", item: { type: "reasoning" } }),
        JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: JSON.stringify(reviewResultJson({ reviewer: "codex" })) } })
      ].join("\n")
    );
    const repo = createRepoWithOneCommit();
    const reviewer = createCodexIndependentReviewer({
      repositoryPath: repo,
      baseCommit: headOf(repo),
      tasks: [{ id: "TASK-01", acceptanceCriteria: [] }],
      config: { executable: process.execPath, baseArgs: [cli] }
    });

    const result = reviewer({ runId: "run-1", graphVersion: 1, taskCommits: {} });

    assert.equal(result.reviewer, "codex");
    assert.equal(result.findings[0]?.id, "REV-LIVE-001");
  });

  it("fails closed when there is no agent_message event", () => {
    const cli = fakeCodexCli(JSON.stringify({ type: "item.started", item: { type: "reasoning" } }));
    const repo = createRepoWithOneCommit();
    const reviewer = createCodexIndependentReviewer({
      repositoryPath: repo,
      baseCommit: headOf(repo),
      tasks: [{ id: "TASK-01", acceptanceCriteria: [] }],
      config: { executable: process.execPath, baseArgs: [cli] },
      now: () => "2026-08-15T10:00:00Z"
    });

    const result = reviewer({ runId: "run-1", graphVersion: 1, taskCommits: {} });

    assert.equal(result.findings[0]?.id, "REV-ENGINE-FAILURE");
  });
});

describe("end-to-end: runFake wired with a real reviewer factory and no repair capability", () => {
  it("BLOCKS with the live reviewer's real finding when structural review fails and no repair executor exists", () => {
    const repo = createReviewFailingRepository();
    const cli = fakeClaudeCli(JSON.stringify({ result: JSON.stringify(reviewResultJson()) }));

    const report = runFake({
      repositoryPath: repo,
      planPath: "Plan/RUN.md",
      runId: "run-e2e-review",
      now: "2026-08-01T10:00:00Z",
      independentReview: {
        reviewer: createClaudeIndependentReviewer({
          repositoryPath: repo,
          baseCommit: headOf(repo),
          tasks: [{ id: "CONTRACT-01", acceptanceCriteria: ["Contract task receives an empty dependency snapshot."] }],
          config: { executable: process.execPath, baseArgs: [cli] }
        }),
        executeRepairCycle: createNoRepairCapabilityExecutor(() => "2026-08-15T10:00:00Z")
      }
    });

    assert.equal(report.status, "BLOCKED");
    assert.equal(report.findings.some((finding) => finding.message.includes("REV-NO-REPAIR-EXECUTOR") || finding.code === "REPAIR_DID_NOT_RESOLVE_REVIEW"), true);
  });
});

function headOf(repo: string): string {
  return execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim();
}

function firstCommit(repo: string): string {
  return execFileSync("git", ["rev-list", "--max-parents=0", "HEAD"], { cwd: repo, encoding: "utf8" }).trim();
}

function createRepoWithOneCommit(): string {
  const repo = mkdtempSync(join(tmpdir(), "aicw-reviewer-cli-"));
  tempDirs.push(repo);
  mkdirSync(join(repo, "src"), { recursive: true });
  writeFileSync(join(repo, "src", "thing.ts"), "export const x = 1;\n", "utf8");
  execFileSync("git", ["init"], { cwd: repo, stdio: "ignore" });
  execFileSync("git", ["add", "."], { cwd: repo, stdio: "ignore" });
  execFileSync(
    "git",
    ["-c", "user.name=t", "-c", "user.email=t@example.test", "commit", "-m", "base"],
    { cwd: repo, stdio: "ignore" }
  );
  return repo;
}

function fakeClaudeCli(stdout: string): string {
  const root = mkdtempSync(join(tmpdir(), "aicw-fake-claude-reviewer-"));
  tempDirs.push(root);
  const cli = join(root, "fake-claude.mjs");
  writeFileSync(cli, `process.stdout.write(${JSON.stringify(stdout)});\n`, "utf8");
  return cli;
}

function fakeClaudeCliExitingNonZero(): string {
  const root = mkdtempSync(join(tmpdir(), "aicw-fake-claude-reviewer-fail-"));
  tempDirs.push(root);
  const cli = join(root, "fake-claude-fail.mjs");
  writeFileSync(cli, `process.stderr.write("boom");\nprocess.exit(1);\n`, "utf8");
  return cli;
}

function fakeClaudeCliCapturingStdin(capturePath: string): string {
  const root = mkdtempSync(join(tmpdir(), "aicw-fake-claude-reviewer-stdin-"));
  tempDirs.push(root);
  const cli = join(root, "fake-claude-stdin.mjs");
  writeFileSync(
    cli,
    `const fs = await import("node:fs");
const chunks = [];
process.stdin.on("data", (chunk) => chunks.push(chunk));
process.stdin.on("end", () => {
  fs.writeFileSync(${JSON.stringify(capturePath)}, Buffer.concat(chunks).toString("utf8"));
  process.stdout.write(${JSON.stringify(JSON.stringify({ result: JSON.stringify(reviewResultJson()) }))});
});
`,
    "utf8"
  );
  return cli;
}

function fakeCodexCli(stdout: string): string {
  const root = mkdtempSync(join(tmpdir(), "aicw-fake-codex-reviewer-"));
  tempDirs.push(root);
  const cli = join(root, "fake-codex.mjs");
  writeFileSync(cli, `process.stdout.write(${JSON.stringify(stdout)});\n`, "utf8");
  return cli;
}

function createReviewFailingRepository(): string {
  const repo = mkdtempSync(join(tmpdir(), "aicw-reviewer-e2e-"));
  tempDirs.push(repo);
  stateRoots.push(resolveStateRoot({ repoRoot: repo }).path);

  mkdirSync(join(repo, "Plan"), { recursive: true });
  writeFileSync(join(repo, "README.md"), "# fixture\n", "utf8");
  writeFileSync(
    join(repo, "Plan", "RUN.md"),
    `---
status: accepted
---

# Independent reviewer e2e fixture

\`\`\`json ai-code-worker-plan
${JSON.stringify(
  {
    goal: "Execute a deterministic fake task flow whose structural review fails, exercising the real reviewer.",
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
        verify: [],
        concurrencyKeys: ["fake-run"],
        risk: "low"
      }
    ],
    globalGates: ['node -e "process.exit(0)"'],
    budgets: {
      maximumParallelWriters: 1,
      maximumRepairCycles: 1,
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
  execFileSync("git", ["add", "README.md", "Plan/RUN.md"], { cwd: repo, stdio: "ignore" });
  execFileSync(
    "git",
    ["-c", "user.name=ai-code-worker", "-c", "user.email=worker@example.test", "commit", "-m", "reviewer e2e fixture"],
    {
      cwd: repo,
      env: { ...process.env, GIT_AUTHOR_DATE: "2026-08-01T10:00:00Z", GIT_COMMITTER_DATE: "2026-08-01T10:00:00Z" },
      stdio: "ignore"
    }
  );

  return repo;
}
