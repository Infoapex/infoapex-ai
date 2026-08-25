import { execFileSync } from "node:child_process";

export interface GitChangedPath {
  readonly path: string;
  readonly status: string;
}

export function currentHead(worktreePath: string): string {
  return git(["rev-parse", "HEAD"], worktreePath);
}

export function listChangedPaths(worktreePath: string): readonly GitChangedPath[] {
  const output = gitRaw(
    ["-c", "core.quotepath=false", "status", "--porcelain=v1", "--untracked-files=all", "-z"],
    worktreePath
  );

  if (!output) {
    return [];
  }

  return parsePorcelainStatusZ(output);
}

export function hasChanges(worktreePath: string): boolean {
  return listChangedPaths(worktreePath).length > 0;
}

export function parsePorcelainStatusZ(output: string): readonly GitChangedPath[] {
  const records = output.split("\0").filter(Boolean);
  const changedPaths: GitChangedPath[] = [];

  for (let index = 0; index < records.length; index += 1) {
    const record = records[index]!;
    const status = record.slice(0, 2);
    const path = record.slice(3);

    if (!path) {
      continue;
    }

    changedPaths.push({ path: normalizeGitPath(path), status });

    if (status.includes("R") || status.includes("C")) {
      const sourcePath = records[index + 1];
      if (sourcePath) {
        changedPaths.push({ path: normalizeGitPath(sourcePath), status: `${status}:source` });
        index += 1;
      }
    }
  }

  return changedPaths;
}

export function git(args: readonly string[], cwd: string): string {
  return gitRaw(args, cwd).trim();
}

function gitRaw(args: readonly string[], cwd: string): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  });
}

function normalizeGitPath(path: string): string {
  return path.replaceAll("\\", "/");
}
