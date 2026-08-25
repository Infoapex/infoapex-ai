import { cherryPickCommit } from "../git/cherry-pick.js";

export interface ConflictReport {
  readonly taskId: string;
  readonly commit: string;
  readonly conflictedPaths: readonly string[];
  readonly baseCommit: string;
  readonly stderr: string;
}

export interface IntegrationResult {
  readonly status: "OK" | "BLOCKED";
  readonly worktreePath: string;
  readonly integratedTaskIds: readonly string[];
  readonly conflictReport: ConflictReport | null;
}

/**
 * Cherry-picks every passed task's commit, in deterministic topological order, onto a
 * dedicated integration worktree. Proves that a wave (or a whole run) of task commits
 * lands cleanly onto one combined tree. On the first conflict, aborts and reports it -
 * never returns a partially-integrated tree as if it were a success.
 */
export function integrateTaskCommits(input: {
  readonly worktreePath: string;
  readonly baseCommit: string;
  readonly orderedTaskIds: readonly string[];
  readonly taskCommits: ReadonlyMap<string, string>;
}): IntegrationResult {
  const integratedTaskIds: string[] = [];

  for (const taskId of input.orderedTaskIds) {
    const commit = input.taskCommits.get(taskId);

    if (!commit) {
      continue;
    }

    const result = cherryPickCommit(input.worktreePath, commit);

    if (result.status === "CONFLICT") {
      return {
        status: "BLOCKED",
        worktreePath: input.worktreePath,
        integratedTaskIds,
        conflictReport: {
          taskId,
          commit,
          conflictedPaths: result.conflictedPaths,
          baseCommit: input.baseCommit,
          stderr: result.stderr
        }
      };
    }

    integratedTaskIds.push(taskId);
  }

  return { status: "OK", worktreePath: input.worktreePath, integratedTaskIds, conflictReport: null };
}
