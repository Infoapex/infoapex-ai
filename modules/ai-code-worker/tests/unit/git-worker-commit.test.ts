import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { createWorkerCommit } from "../../src/git/commit.js";
import { currentHead, listChangedPaths, parsePorcelainStatusZ } from "../../src/git/diff.js";
import { createTaskWorktree, taskWorktreeBranch, taskWorktreePath } from "../../src/git/worktree.js";
import { resolveStateRoot } from "../../src/state/state-root.js";

const tempRoots: string[] = [];

after(() => {
  for (const root of tempRoots) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("git task worktree and worker commit", () => {
  it("uses bounded hashed branch segments for deeply nested Windows worktrees", () => {
    const branch = taskWorktreeBranch({
      runId: "run-".repeat(30),
      taskId: "CONSUMER-HEALTH-ENVIRONMENT-FIELD-".repeat(12),
      attempt: 1
    });

    assert.match(branch, /^aiw\/t\/[a-f0-9]{16}\/[a-f0-9]{16}\/a1$/);
    assert.ok(branch.length < 50);
    const path = taskWorktreePath({ stateRoot: "C:/very/deep/state/root", runId: "run-".repeat(30), taskId: "TASK-".repeat(30), attempt: 1 });
    assert.match(path.replaceAll("\\", "/"), /worktrees\/[a-f0-9]{16}\/[a-f0-9]{16}\/a1$/);
  });

  it("creates a task worktree outside the repository and commits scoped changes with audit trailers", () => {
    const repo = createGitRepository();
    const baseCommit = currentHead(repo);
    const stateRoot = resolveStateRoot({ repoRoot: repo }).path;
    tempRoots.push(stateRoot);

    const worktree = createTaskWorktree({
      repositoryPath: repo,
      stateRoot,
      runId: "run-phase1",
      taskId: "BACKEND-01",
      attempt: 1,
      baseCommit
    });

    assert.equal(worktree.status, "CREATED");
    assert.ok(worktree.worktree);
    assert.equal(worktree.worktree.path.startsWith(repo), false);
    assert.equal(worktree.worktree.headCommit, baseCommit);
    if (process.platform === "win32") {
      assert.equal(execFileSync("git", ["config", "--get", "core.longpaths"], { cwd: repo, encoding: "utf8" }).trim(), "true");
    }

    mkdirSync(join(worktree.worktree.path, "src"), { recursive: true });
    writeFileSync(join(worktree.worktree.path, "src", "feature.ts"), "export const value = 1;\n", "utf8");

    const report = createWorkerCommit({
      worktreePath: worktree.worktree.path,
      expectedHead: baseCommit,
      runId: "run-phase1",
      taskId: "BACKEND-01",
      manifestSha256: "a".repeat(64),
      allowedPaths: ["src/**"],
      forbiddenPaths: [".git/**"],
      message: "Implement BACKEND-01"
    });

    assert.equal(report.status, "COMMITTED");
    assert.ok(report.commit);
    assert.match(report.commit.sha, /^[a-f0-9]{40}$/);
    assert.deepEqual(report.changedPaths, ["src/feature.ts"]);
    assert.equal(report.commit.trailers["ai-code-worker-run"], "run-phase1");
    assert.match(report.commit.message, /ai-code-worker-task: BACKEND-01/);
    assert.equal(currentHead(repo), baseCommit);
    assert.equal(existsSync(join(repo, "src", "feature.ts")), false);
  });

  it("blocks commits when changed paths are outside the task scope", () => {
    const repo = createGitRepository();
    const baseCommit = currentHead(repo);
    const stateRoot = resolveStateRoot({ repoRoot: repo }).path;
    tempRoots.push(stateRoot);
    const worktree = createTaskWorktree({
      repositoryPath: repo,
      stateRoot,
      runId: "run-scope",
      taskId: "BACKEND-01",
      attempt: 1,
      baseCommit
    }).worktree!;

    mkdirSync(join(worktree.path, "tests"), { recursive: true });
    writeFileSync(join(worktree.path, "tests", "outside.test.ts"), "test\n", "utf8");

    const report = createWorkerCommit({
      worktreePath: worktree.path,
      expectedHead: baseCommit,
      runId: "run-scope",
      taskId: "BACKEND-01",
      manifestSha256: "b".repeat(64),
      allowedPaths: ["src/**"],
      forbiddenPaths: [".git/**"],
      message: "Attempt out-of-scope change"
    });

    assert.equal(report.status, "BLOCKED");
    assert.equal(report.findings[0]?.code, "SCOPE_VIOLATION");
    assert.equal(currentHead(worktree.path), baseCommit);
  });

  it("blocks commits when the agent has moved HEAD before worker commit", () => {
    const repo = createGitRepository();
    const baseCommit = currentHead(repo);
    const stateRoot = resolveStateRoot({ repoRoot: repo }).path;
    tempRoots.push(stateRoot);
    const worktree = createTaskWorktree({
      repositoryPath: repo,
      stateRoot,
      runId: "run-head",
      taskId: "BACKEND-01",
      attempt: 1,
      baseCommit
    }).worktree!;

    writeFileSync(join(worktree.path, "README.md"), "# changed by agent\n", "utf8");
    execFileSync("git", ["add", "README.md"], { cwd: worktree.path, stdio: "ignore" });
    execFileSync("git", ["-c", "user.name=agent", "-c", "user.email=agent@example.test", "commit", "-m", "unauthorized"], {
      cwd: worktree.path,
      stdio: "ignore"
    });

    const report = createWorkerCommit({
      worktreePath: worktree.path,
      expectedHead: baseCommit,
      runId: "run-head",
      taskId: "BACKEND-01",
      manifestSha256: "c".repeat(64),
      allowedPaths: ["README.md"],
      forbiddenPaths: [],
      message: "Should block"
    });

    assert.equal(report.status, "BLOCKED");
    assert.equal(report.findings[0]?.code, "HEAD_CHANGED");
  });

  it("initializes repository submodules in task worktrees before hook-backed commits", () => {
    const dependencyRepo = createGitRepository();
    writeFileSync(join(dependencyRepo, "tool.txt"), "submodule tool\n", "utf8");
    execFileSync("git", ["add", "tool.txt"], { cwd: dependencyRepo, stdio: "ignore" });
    execFileSync("git", ["-c", "user.name=ai-code-worker", "-c", "user.email=worker@example.test", "commit", "-m", "add tool"], {
      cwd: dependencyRepo,
      stdio: "ignore"
    });

    const repo = createGitRepository();
    execFileSync("git", ["config", "protocol.file.allow", "always"], { cwd: repo, stdio: "ignore" });
    execFileSync("git", ["-c", "protocol.file.allow=always", "submodule", "add", dependencyRepo, "tools/dependency"], {
      cwd: repo,
      stdio: "ignore"
    });
    mkdirSync(join(repo, ".git", "hooks"), { recursive: true });
    writeFileSync(
      join(repo, ".git", "hooks", "pre-commit"),
      "#!/bin/sh\nset -eu\ntest -f tools/dependency/tool.txt\n",
      { encoding: "utf8", mode: 0o755 }
    );
    execFileSync("git", ["add", ".gitmodules", "tools/dependency"], { cwd: repo, stdio: "ignore" });
    execFileSync("git", ["-c", "user.name=ai-code-worker", "-c", "user.email=worker@example.test", "commit", "-m", "add submodule"], {
      cwd: repo,
      stdio: "ignore"
    });

    const baseCommit = currentHead(repo);
    const stateRoot = resolveStateRoot({ repoRoot: repo }).path;
    tempRoots.push(stateRoot);
    const previousProtocol = process.env.GIT_ALLOW_PROTOCOL;
    process.env.GIT_ALLOW_PROTOCOL = "file:git:https:ssh";
    const worktreeReport = createTaskWorktree({
      repositoryPath: repo,
      stateRoot,
      runId: "run-submodule-hook",
      taskId: "BACKEND-01",
      attempt: 1,
      baseCommit
    });
    if (previousProtocol === undefined) {
      delete process.env.GIT_ALLOW_PROTOCOL;
    } else {
      process.env.GIT_ALLOW_PROTOCOL = previousProtocol;
    }

    assert.equal(worktreeReport.status, "CREATED", worktreeReport.findings[0]?.message);
    const worktree = worktreeReport.worktree!;

    assert.equal(existsSync(join(worktree.path, "tools", "dependency", "tool.txt")), true);

    mkdirSync(join(worktree.path, "src"), { recursive: true });
    writeFileSync(join(worktree.path, "src", "feature.ts"), "export const value = 1;\n", "utf8");

    const report = createWorkerCommit({
      worktreePath: worktree.path,
      expectedHead: baseCommit,
      runId: "run-submodule-hook",
      taskId: "BACKEND-01",
      manifestSha256: "d".repeat(64),
      allowedPaths: ["src/**"],
      forbiddenPaths: [".git/**"],
      message: "Commit with hook-backed submodule"
    });

    assert.equal(report.status, "COMMITTED");
  });

  it("materializes a temporary ai-code-control hook manifest for task branches", () => {
    const repo = createGitRepository();
    mkdirSync(join(repo, ".ai-code-control", "reports", "refactor"), { recursive: true });
    const originalManifest = {
      schemaVersion: "1.0",
      taskId: "ORIGINAL",
      branch: "main",
      allowedFiles: ["README.md"],
      allowedPatterns: [],
      forbiddenPaths: []
    };
    const manifestPath = join(repo, ".ai-code-control", "reports", "refactor", "current-plan.json");
    writeFileSync(manifestPath, `${JSON.stringify(originalManifest, null, 2)}\n`, "utf8");
    execFileSync("git", ["add", ".ai-code-control/reports/refactor/current-plan.json"], { cwd: repo, stdio: "ignore" });
    execFileSync("git", ["-c", "user.name=ai-code-worker", "-c", "user.email=worker@example.test", "commit", "-m", "add hook manifest"], {
      cwd: repo,
      stdio: "ignore"
    });

    mkdirSync(join(repo, ".git", "hooks"), { recursive: true });
    writeFileSync(
      join(repo, ".git", "hooks", "pre-commit"),
      [
        "#!/bin/sh",
        "set -eu",
        "branch=$(git branch --show-current)",
        "node -e \"const fs=require('fs'); const m=JSON.parse(fs.readFileSync('.ai-code-control/reports/refactor/current-plan.json','utf8')); if (m.branch !== process.argv[1]) process.exit(1);\" \"$branch\""
      ].join("\n"),
      { encoding: "utf8", mode: 0o755 }
    );

    const baseCommit = currentHead(repo);
    const stateRoot = resolveStateRoot({ repoRoot: repo }).path;
    tempRoots.push(stateRoot);
    const worktree = createTaskWorktree({
      repositoryPath: repo,
      stateRoot,
      runId: "run-hook-manifest",
      taskId: "BACKEND-01",
      attempt: 1,
      baseCommit
    }).worktree!;

    mkdirSync(join(worktree.path, "src"), { recursive: true });
    writeFileSync(join(worktree.path, "src", "feature.ts"), "export const value = 1;\n", "utf8");

    const report = createWorkerCommit({
      worktreePath: worktree.path,
      expectedHead: baseCommit,
      runId: "run-hook-manifest",
      taskId: "BACKEND-01",
      manifestSha256: "e".repeat(64),
      allowedPaths: ["src/**"],
      forbiddenPaths: [".git/**"],
      message: "Commit with temporary hook manifest"
    });

    assert.equal(report.status, "COMMITTED");
    assert.deepEqual(JSON.parse(readFileSync(join(worktree.path, ".ai-code-control", "reports", "refactor", "current-plan.json"), "utf8")), originalManifest);
    assert.equal(gitShowFile(worktree.path, report.commit!.sha, ".ai-code-control/reports/refactor/current-plan.json").includes("ORIGINAL"), true);
  });

  it("parses porcelain rename records with both source and destination paths", () => {
    const parsed = parsePorcelainStatusZ("R  src/new.ts\0src/old.ts\0");

    assert.deepEqual(parsed, [
      { status: "R ", path: "src/new.ts" },
      { status: "R :source", path: "src/old.ts" }
    ]);
  });

  it("lists modified, deleted, and untracked worktree paths", () => {
    const repo = createGitRepository();
    writeFileSync(join(repo, "README.md"), "# changed\n", "utf8");
    writeFileSync(join(repo, "new.txt"), "new\n", "utf8");

    assert.deepEqual(
      listChangedPaths(repo).map((change) => change.path).sort(),
      ["README.md", "new.txt"]
    );
  });
});

function createGitRepository(): string {
  const repo = mkdtempSync(join(tmpdir(), "aicw-git-"));
  tempRoots.push(repo);

  execFileSync("git", ["init"], { cwd: repo, stdio: "ignore" });
  writeFileSync(join(repo, "README.md"), "# fixture\n", "utf8");
  execFileSync("git", ["add", "README.md"], { cwd: repo, stdio: "ignore" });
  execFileSync("git", ["-c", "user.name=ai-code-worker", "-c", "user.email=worker@example.test", "commit", "-m", "init"], {
    cwd: repo,
    stdio: "ignore"
  });

  return repo;
}

function gitShowFile(repo: string, commit: string, path: string): string {
  return execFileSync("git", ["show", `${commit}:${path}`], {
    cwd: repo,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  });
}
