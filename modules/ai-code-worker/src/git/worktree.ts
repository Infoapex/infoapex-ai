import { createHash } from "node:crypto";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { gitPreflight } from "./preflight.js";
import { currentHead, git } from "./diff.js";

export interface CreateTaskWorktreeInput {
  readonly repositoryPath: string;
  readonly stateRoot: string;
  readonly runId: string;
  readonly taskId: string;
  readonly attempt: number;
  readonly baseCommit: string;
  readonly branchPrefix?: string;
  /** If a worktree already exists at the target path (e.g. left behind by a
   *  killed process), remove it and create fresh instead of blocking. Only
   *  safe for scratch worktrees with no independently-recoverable state of
   *  their own - never set this for task worktrees, whose recovery instead
   *  goes through the committed-commit checkpoint path. */
  readonly recreateIfExists?: boolean;
}

export interface TaskWorktree {
  readonly path: string;
  readonly branch: string;
  readonly headCommit: string;
}

export interface CreateTaskWorktreeReport {
  readonly status: "CREATED" | "BLOCKED";
  readonly worktree: TaskWorktree | null;
  readonly findings: readonly TaskWorktreeFinding[];
}

export interface TaskWorktreeFinding {
  readonly code: "GIT_PREFLIGHT_FAILED" | "WORKTREE_PATH_EXISTS" | "WORKTREE_CREATE_FAILED";
  readonly message: string;
}

export function createTaskWorktree(input: CreateTaskWorktreeInput): CreateTaskWorktreeReport {
  const repository = gitPreflight(input.repositoryPath);

  if (!repository.ok) {
    return blocked("GIT_PREFLIGHT_FAILED", repository.reason);
  }

  const worktreePath = taskWorktreePath(input);
  const branch = taskWorktreeBranch(input);

  if (existsSync(worktreePath)) {
    if (!input.recreateIfExists) {
      return blocked("WORKTREE_PATH_EXISTS", `Worktree path already exists: ${worktreePath}`);
    }

    removeStaleWorktree(repository.worktreeRoot, worktreePath);
  }

  try {
    mkdirSync(dirname(worktreePath), { recursive: true });
    if (process.platform === "win32") {
      // The isolated benchmark source can legitimately contain long generated
      // design/mockup paths. Configure only its local Git admin directory before
      // checkout; never require a machine-wide Git setting or alter the consumer
      // repository's global configuration.
      git(["config", "core.longpaths", "true"], repository.worktreeRoot);
    }
    git(["worktree", "add", "-B", branch, worktreePath, input.baseCommit], repository.worktreeRoot);
    if (existsSync(join(worktreePath, ".gitmodules"))) {
      git(["submodule", "update", "--init", "--recursive"], worktreePath);
    }

    return {
      status: "CREATED",
      worktree: {
        path: worktreePath,
        branch,
        headCommit: currentHead(worktreePath)
      },
      findings: []
    };
  } catch (error) {
    return blocked("WORKTREE_CREATE_FAILED", error instanceof Error ? error.message : String(error));
  }
}

function removeStaleWorktree(repositoryWorktreeRoot: string, worktreePath: string): void {
  try {
    git(["worktree", "remove", "--force", worktreePath], repositoryWorktreeRoot);
    return;
  } catch {
    // Not a registered worktree (e.g. a partially-created directory from a
    // crash before "git worktree add" completed) - fall through to a plain
    // filesystem removal plus a prune of git's own bookkeeping.
  }

  rmSync(worktreePath, { recursive: true, force: true });

  try {
    git(["worktree", "prune"], repositoryWorktreeRoot);
  } catch {
    // Best-effort: stale administrative files left under .git/worktrees
    // don't block a fresh "git worktree add" at the same path.
  }
}

function blocked(code: TaskWorktreeFinding["code"], message: string): CreateTaskWorktreeReport {
  return {
    status: "BLOCKED",
    worktree: null,
    findings: [{ code, message }]
  };
}

function safeRefSegment(value: string): string {
  return value
    .trim()
    .replaceAll("\\", "-")
    .replaceAll("/", "-")
    .replace(/[^A-Za-z0-9._-]/g, "-")
    .replace(/^[.-]+|[.-]+$/g, "")
    .slice(0, 80);
}

/**
 * Keep task branches independent of source path length.  A benchmark safe-copy
 * can already have a deep evaluator path; embedding whole run/task identifiers
 * under `.git/refs/heads` then crosses Windows' legacy path boundary before the
 * provider is reached. Hashes preserve collision resistance without exposing
 * task text in Git refs. The human-readable IDs remain in run evidence.
 */
export function taskWorktreeBranch(input: Pick<CreateTaskWorktreeInput, "runId" | "taskId" | "attempt" | "branchPrefix">): string {
  const prefix = (input.branchPrefix ?? "aiw/t")
    .split("/")
    .map(safeRefSegment)
    .filter(Boolean)
    .join("/") || "aiw/t";
  return `${prefix}/${shortRefHash(input.runId)}/${shortRefHash(input.taskId)}/a${input.attempt}`;
}

/** Filesystem companion to taskWorktreeBranch. Keep stable IDs in evidence,
 * but never place them verbatim in a path consumed by Windows test hosts. */
export function taskWorktreePath(input: Pick<CreateTaskWorktreeInput, "stateRoot" | "runId" | "taskId" | "attempt">): string {
  return join(input.stateRoot, "worktrees", shortRefHash(input.runId), shortRefHash(input.taskId), `a${input.attempt}`);
}

function shortRefHash(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex").slice(0, 16);
}
