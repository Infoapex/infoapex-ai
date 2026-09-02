import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
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
  // realpathSync, not a plain resolve: `git rev-parse --show-toplevel` below returns
  // git's own canonicalized path, which is not guaranteed to be the same STRING as
  // whatever form the caller passed in. Confirmed live on GitHub Actions
  // windows-latest, 2026-09-02: os.tmpdir() there returns the short (8.3) form of the
  // runner's home directory (`C:\Users\RUNNER~1\...`), while git resolves the same
  // real directory to its long form with forward slashes
  // (`C:/Users/runneradmin/...`). Every later comparison in this codebase
  // (compile.ts's isPathInside(worktreeRoot, planAbsolutePath), state-root.ts's
  // repositoryHash) assumes `requestedPath` and `worktreeRoot` denote the exact same
  // string for the exact same directory - realpathSync here is what actually
  // guarantees that, since path.resolve() is pure string manipulation and cannot
  // reconcile two different real-filesystem aliases of the same directory.
  const requestedPath = realpathSync(resolve(repositoryPath));

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
