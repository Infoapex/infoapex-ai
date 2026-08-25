import { execFileSync } from "node:child_process";
import { resolve } from "node:path";

export interface GitPreflight {
  readonly ok: true;
  readonly requestedPath: string;
  readonly worktreeRoot: string;
  readonly gitCommonDir: string;
  readonly headCommit: string;
}

export interface GitPreflightFailure {
  readonly ok: false;
  readonly requestedPath: string;
  readonly reason: string;
}

export type GitPreflightResult = GitPreflight | GitPreflightFailure;

export function gitPreflight(repositoryPath: string): GitPreflightResult {
  const requestedPath = resolve(repositoryPath);

  try {
    const worktreeRoot = git(["rev-parse", "--show-toplevel"], requestedPath);
    const rawCommonDir = git(["rev-parse", "--git-common-dir"], requestedPath);
    const headCommit = git(["rev-parse", "HEAD"], requestedPath);
    const gitCommonDir = resolveGitPath(worktreeRoot, rawCommonDir);

    return {
      ok: true,
      requestedPath,
      worktreeRoot,
      gitCommonDir,
      headCommit
    };
  } catch (error) {
    return {
      ok: false,
      requestedPath,
      reason: error instanceof Error ? error.message : String(error)
    };
  }
}

function git(args: readonly string[], cwd: string): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  }).trim();
}

function resolveGitPath(worktreeRoot: string, path: string): string {
  return resolve(worktreeRoot, path);
}
