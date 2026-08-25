import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, describe, it } from "node:test";
import { cherryPickCommit, cherryPickSequence } from "../../src/git/cherry-pick.js";

const tempRepos: string[] = [];

after(() => {
  for (const repo of tempRepos) {
    rmSync(repo, { recursive: true, force: true });
  }
});

describe("cherry-pick", () => {
  it("cherry-picks a clean commit successfully", () => {
    const repo = createGitRepository();
    const base = baseCommit(repo);
    const commit = commitFile(repo, "src/a.txt", "a\n", "add a");

    const worktree = addWorktree(repo, "worktree-clean", base);
    const result = cherryPickCommit(worktree, commit);

    assert.equal(result.status, "OK");
    assert.equal(existsSync(join(worktree, "src", "a.txt")), true);
  });

  it("reports a conflict with the conflicted paths and leaves the worktree clean", () => {
    const repo = createGitRepository();
    mkdirSync(join(repo, "src"), { recursive: true });
    writeFileSync(join(repo, "src", "shared.txt"), "base\n", "utf8");
    execFileSync("git", ["add", "src/shared.txt"], { cwd: repo, stdio: "ignore" });
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t.com", "commit", "-m", "base shared"], {
      cwd: repo,
      stdio: "ignore"
    });
    const sharedBase = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim();

    // Commit A changes shared.txt on main.
    writeFileSync(join(repo, "src", "shared.txt"), "changed-on-main\n", "utf8");
    execFileSync("git", ["add", "src/shared.txt"], { cwd: repo, stdio: "ignore" });
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t.com", "commit", "-m", "change on main"], {
      cwd: repo,
      stdio: "ignore"
    });
    const mainTip = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim();

    // Commit B, in its own worktree branched from sharedBase, changes shared.txt differently.
    const branchWorktree = addWorktree(repo, "worktree-conflict-source", sharedBase);
    writeFileSync(join(branchWorktree, "src", "shared.txt"), "changed-on-branch\n", "utf8");
    execFileSync("git", ["add", "src/shared.txt"], { cwd: branchWorktree, stdio: "ignore" });
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t.com", "commit", "-m", "change on branch"], {
      cwd: branchWorktree,
      stdio: "ignore"
    });
    const conflictingCommit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: branchWorktree, encoding: "utf8" }).trim();

    // Cherry-pick the branch's conflicting commit onto a separate worktree sitting at main's tip.
    const targetWorktree = addWorktree(repo, "worktree-conflict-target", mainTip);
    const result = cherryPickCommit(targetWorktree, conflictingCommit);

    assert.equal(result.status, "CONFLICT");
    if (result.status === "CONFLICT") {
      assert.deepEqual(result.conflictedPaths, ["src/shared.txt"]);
      assert.ok(result.stderr.length > 0);
    }

    // The worktree must be left clean, not mid-conflict.
    const status = execFileSync("git", ["status", "--porcelain"], { cwd: targetWorktree, encoding: "utf8" }).trim();
    assert.equal(status, "");
    const sequencerInProgress = existsSync(join(targetWorktree, ".git", "CHERRY_PICK_HEAD"));
    assert.equal(sequencerInProgress, false);
  });

  it("cherryPickSequence stops at the first conflicting commit", () => {
    const repo = createGitRepository();
    const base = baseCommit(repo);
    const commitA = commitFile(repo, "src/a.txt", "a\n", "add a");
    const worktree = addWorktree(repo, "worktree-seq", base);

    const result = cherryPickSequence(worktree, [commitA, "0000000000000000000000000000000000000000"]);

    assert.equal(result.status, "CONFLICT");
  });
});

function createGitRepository(): string {
  const repo = mkdtempSync(join(tmpdir(), "aicw-cherry-pick-"));
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

function commitFile(repo: string, relativePath: string, content: string, message: string): string {
  const fullPath = join(repo, ...relativePath.split("/"));
  mkdirSync(dirname(fullPath), { recursive: true });
  writeFileSync(fullPath, content, "utf8");
  execFileSync("git", ["add", relativePath], { cwd: repo, stdio: "ignore" });
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t.com", "commit", "-m", message], {
    cwd: repo,
    stdio: "ignore"
  });
  return execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim();
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
