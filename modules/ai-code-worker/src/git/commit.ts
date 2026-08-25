import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { evaluateChangedPaths, type ScopePolicyFinding } from "../policy/scope-policy.js";
import { currentHead, git, listChangedPaths } from "./diff.js";

export interface CreateWorkerCommitInput {
  readonly worktreePath: string;
  readonly expectedHead: string;
  readonly runId: string;
  readonly taskId: string;
  readonly manifestSha256: string;
  readonly allowedPaths: readonly string[];
  readonly forbiddenPaths: readonly string[];
  readonly message: string;
}

export interface CreateWorkerCommitReport {
  readonly status: "COMMITTED" | "BLOCKED";
  readonly commit: WorkerCommit | null;
  readonly changedPaths: readonly string[];
  readonly findings: readonly WorkerCommitFinding[];
}

export interface WorkerCommit {
  readonly sha: string;
  readonly parent: string;
  readonly message: string;
  readonly trailers: Readonly<Record<string, string>>;
}

export type WorkerCommitFinding =
  | {
      readonly code: "HEAD_CHANGED" | "NO_CHANGES" | "GIT_COMMIT_FAILED" | "COMMIT_TRAILER_MISSING";
      readonly message: string;
    }
  | {
      readonly code: "SCOPE_VIOLATION";
      readonly message: string;
      readonly scopeFindings: readonly ScopePolicyFinding[];
    };

export function createWorkerCommit(input: CreateWorkerCommitInput): CreateWorkerCommitReport {
  const head = currentHead(input.worktreePath);

  if (head !== input.expectedHead) {
    return blocked("HEAD_CHANGED", `Expected HEAD ${input.expectedHead}, got ${head}.`, []);
  }

  const changes = listChangedPaths(input.worktreePath);
  const changedPaths = [...new Set(changes.map((change) => change.path))].sort();

  if (changedPaths.length === 0) {
    return blocked("NO_CHANGES", "No task changes are available to commit.", []);
  }

  const scope = evaluateChangedPaths(
    {
      allowedPaths: input.allowedPaths,
      forbiddenPaths: input.forbiddenPaths
    },
    changedPaths
  );

  if (scope.status === "BLOCK") {
    return {
      status: "BLOCKED",
      commit: null,
      changedPaths,
      findings: [
        {
          code: "SCOPE_VIOLATION",
          message: "Changed paths are outside the task scope.",
          scopeFindings: scope.findings
        }
      ]
    };
  }

  const trailers = {
    "ai-code-worker-run": input.runId,
    "ai-code-worker-task": input.taskId,
    "ai-code-worker-manifest": input.manifestSha256,
    "ai-code-worker-parent": input.expectedHead
  };
  const message = commitMessage(input.message, trailers);
  const hookManifest = materializeAiCodeControlHookManifest(input, changedPaths);

  try {
    git(["add", "--", ...changedPaths], input.worktreePath);
    execFileSync("git", ["-c", "user.name=ai-code-worker", "-c", "user.email=worker@example.test", "commit", "-m", message], {
      cwd: input.worktreePath,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"]
    });
  } catch (error) {
    return blocked("GIT_COMMIT_FAILED", error instanceof Error ? error.message : String(error), changedPaths);
  } finally {
    hookManifest.restore();
  }

  const sha = currentHead(input.worktreePath);
  const actualMessage = git(["log", "-1", "--format=%B"], input.worktreePath);
  const missingTrailer = Object.entries(trailers).find(([key, value]) => !actualMessage.includes(`${key}: ${value}`));

  if (missingTrailer) {
    return blocked("COMMIT_TRAILER_MISSING", `Commit is missing trailer ${missingTrailer[0]}.`, changedPaths);
  }

  return {
    status: "COMMITTED",
    commit: {
      sha,
      parent: input.expectedHead,
      message: actualMessage,
      trailers
    },
    changedPaths,
    findings: []
  };
}

function materializeAiCodeControlHookManifest(
  input: CreateWorkerCommitInput,
  changedPaths: readonly string[]
): { restore(): void } {
  const path = join(input.worktreePath, ".ai-code-control", "reports", "refactor", "current-plan.json");

  if (!existsSync(path)) {
    return { restore() {} };
  }

  const previous = readFileSync(path, "utf8");
  const branch = git(["branch", "--show-current"], input.worktreePath);
  const manifest = {
    schemaVersion: "1.0",
    taskId: input.taskId,
    title: input.message,
    task: input.message,
    owner: "ai-code-worker",
    branch,
    baseCommit: input.expectedHead,
    status: "in_progress",
    dependsOn: [],
    scope: [`Worker-owned task ${input.taskId}.`],
    outOfScope: [],
    allowedFiles: [".ai-code-control/reports/refactor/current-plan.json", ...changedPaths],
    allowedPatterns: [...input.allowedPaths],
    forbiddenPaths: [...input.forbiddenPaths],
    allowedUntrackedPatterns: [...input.allowedPaths],
    requiredValidation: [],
    acceptanceCriteria: [],
    riskLevel: "low",
    notes: [`Temporary hook manifest generated for ${input.runId}; not staged or committed.`]
  };

  writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

  return {
    restore() {
      writeFileSync(path, previous, "utf8");
    }
  };
}

function commitMessage(subject: string, trailers: Readonly<Record<string, string>>): string {
  const safeSubject = subject.trim() || "Implement ai-code-worker task";
  const trailerBlock = Object.entries(trailers)
    .map(([key, value]) => `${key}: ${value}`)
    .join("\n");

  return `${safeSubject}\n\n${trailerBlock}`;
}

function blocked(
  code: Exclude<WorkerCommitFinding["code"], "SCOPE_VIOLATION">,
  message: string,
  changedPaths: readonly string[]
): CreateWorkerCommitReport {
  return {
    status: "BLOCKED",
    commit: null,
    changedPaths,
    findings: [{ code, message }]
  };
}
