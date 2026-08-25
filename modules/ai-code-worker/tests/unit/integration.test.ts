import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, describe, it } from "node:test";
import { integrateTaskCommits } from "../../src/run/integration.js";

const tempRepos: string[] = [];

after(() => {
  for (const repo of tempRepos) {
    rmSync(repo, { recursive: true, force: true });
  }
});

describe("integration", () => {
  it("integrates two independent task commits deterministically onto one worktree", () => {
    const repo = createGitRepository();
    const base = baseCommit(repo);

    const commitA = commitOnBranch(repo, "branch-a", base, "src/a.txt", "a\n", "task A");
    const commitB = commitOnBranch(repo, "branch-b", base, "src/b.txt", "b\n", "task B");

    const integrationWorktree = addWorktree(repo, "integration", base);
    const result = integrateTaskCommits({
      worktreePath: integrationWorktree,
      baseCommit: base,
      orderedTaskIds: ["A", "B"],
      taskCommits: new Map([
        ["A", commitA],
        ["B", commitB]
      ])
    });

    assert.equal(result.status, "OK");
    assert.deepEqual(result.integratedTaskIds, ["A", "B"]);
    assert.equal(existsSync(join(integrationWorktree, "src", "a.txt")), true);
    assert.equal(existsSync(join(integrationWorktree, "src", "b.txt")), true);
  });

  it("reports a conflict and stops integrating further tasks when two commits touch the same file", () => {
    const repo = createGitRepository();
    const base = baseCommit(repo);

    const commitA = commitOnBranch(repo, "branch-a2", base, "src/shared.txt", "from-a\n", "task A");
    const commitB = commitOnBranch(repo, "branch-b2", base, "src/shared.txt", "from-b\n", "task B");

    const integrationWorktree = addWorktree(repo, "integration-conflict", base);
    const result = integrateTaskCommits({
      worktreePath: integrationWorktree,
      baseCommit: base,
      orderedTaskIds: ["A", "B"],
      taskCommits: new Map([
        ["A", commitA],
        ["B", commitB]
      ])
    });

    assert.equal(result.status, "BLOCKED");
    assert.deepEqual(result.integratedTaskIds, ["A"]);
    assert.ok(result.conflictReport);
    assert.equal(result.conflictReport?.taskId, "B");
    assert.deepEqual(result.conflictReport?.conflictedPaths, ["src/shared.txt"]);
  });

  it("only integrates tasks that have a recorded commit, skipping ones without", () => {
    const repo = createGitRepository();
    const base = baseCommit(repo);
    const commitA = commitOnBranch(repo, "branch-a3", base, "src/a.txt", "a\n", "task A");

    const integrationWorktree = addWorktree(repo, "integration-partial", base);
    const result = integrateTaskCommits({
      worktreePath: integrationWorktree,
      baseCommit: base,
      orderedTaskIds: ["A", "B"],
      taskCommits: new Map([["A", commitA]])
    });

    assert.equal(result.status, "OK");
    assert.deepEqual(result.integratedTaskIds, ["A"]);
  });
});

function createGitRepository(): string {
  const repo = mkdtempSync(join(tmpdir(), "aicw-integration-"));
  tempRepos.push(repo);

  execFileSync("git", ["init", "-b", "main"], { cwd: repo, stdio: "ignore" });
  writeFileSync(join(repo, "README.md"), "# fixture\n", "utf8");
  execFileSync("git", ["add", "README.md"], { cwd: repo, stdio: "ignore" });
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t.com", "commit", "-m", "init"], {
    cwd: repo,
    stdio: "ignore"
  });

  return repo;
}

function baseCommit(repo: string): string {
  return execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim();
}

function commitOnBranch(
  repo: string,
  branchName: string,
  baseCommitSha: string,
  relativePath: string,
  content: string,
  message: string
): string {
  const worktreePath = addWorktree(repo, branchName, baseCommitSha);
  const fullPath = join(worktreePath, ...relativePath.split("/"));
  mkdirSync(dirname(fullPath), { recursive: true });
  writeFileSync(fullPath, content, "utf8");
  execFileSync("git", ["add", relativePath], { cwd: worktreePath, stdio: "ignore" });
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t.com", "commit", "-m", message], {
    cwd: worktreePath,
    stdio: "ignore"
  });
  return execFileSync("git", ["rev-parse", "HEAD"], { cwd: worktreePath, encoding: "utf8" }).trim();
}

function addWorktree(repo: string, name: string, baseCommitSha: string): string {
  const worktreePath = join(repo, "..", `${name}-${Math.random().toString(16).slice(2)}`);
  execFileSync("git", ["worktree", "add", "-B", `branch-${name}`, worktreePath, baseCommitSha], {
    cwd: repo,
    stdio: "ignore"
  });
  tempRepos.push(worktreePath);
  return worktreePath;
}
