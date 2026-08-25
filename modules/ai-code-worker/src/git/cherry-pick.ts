import { git } from "./diff.js";

export interface CherryPickOk {
  readonly status: "OK";
  readonly commit: string;
}

export interface CherryPickConflict {
  readonly status: "CONFLICT";
  readonly commit: string;
  readonly conflictedPaths: readonly string[];
  readonly stderr: string;
}

export type CherryPickResult = CherryPickOk | CherryPickConflict;

/**
 * Cherry-picks a single commit into a worktree. On conflict, collects the conflicted
 * paths and aborts the cherry-pick so the worktree is left clean rather than mid-conflict -
 * callers must treat a CONFLICT result as BLOCKED, never partial success.
 */
export function cherryPickCommit(worktreePath: string, commit: string): CherryPickResult {
  try {
    // Integration worktrees are scratch branches owned by the worker. Set an
    // explicit committer so clean CI runners and user environments without a
    // global Git identity behave the same way.
    git(["-c", "user.name=ai-code-worker", "-c", "user.email=worker@example.test", "cherry-pick", "--no-gpg-sign", commit], worktreePath);
    return { status: "OK", commit };
  } catch (error) {
    const conflictedPaths = listConflictedPaths(worktreePath);
    const stderr = readStderr(error);

    try {
      git(["cherry-pick", "--abort"], worktreePath);
    } catch {
      // Best-effort abort - if there was nothing to abort (the failure was not a
      // real merge conflict), this is a safe no-op.
    }

    return { status: "CONFLICT", commit, conflictedPaths, stderr };
  }
}

/**
 * Cherry-picks a sequence of commits in order, stopping at the first conflict.
 */
export function cherryPickSequence(
  worktreePath: string,
  commits: readonly string[]
): CherryPickResult | { readonly status: "OK"; readonly commit: null } {
  for (const commit of commits) {
    const result = cherryPickCommit(worktreePath, commit);
    if (result.status === "CONFLICT") {
      return result;
    }
  }

  return { status: "OK", commit: null };
}

function listConflictedPaths(worktreePath: string): readonly string[] {
  try {
    const output = git(["diff", "--name-only", "--diff-filter=U"], worktreePath);
    return output.length > 0 ? output.split("\n").filter((line) => line.length > 0) : [];
  } catch {
    return [];
  }
}

function readStderr(error: unknown): string {
  if (error && typeof error === "object" && "stderr" in error) {
    const stderr = (error as { readonly stderr?: unknown }).stderr;
    if (typeof stderr === "string") {
      return stderr;
    }
    if (stderr) {
      return String(stderr);
    }
  }

  return error instanceof Error ? error.message : String(error);
}
