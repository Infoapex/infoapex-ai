import type { RunEvent } from "./event-log.js";

export interface RunCheckpoints {
  readonly terminal: "DONE" | "BLOCKED" | null;
  readonly blockedReason: string | null;
  readonly tasks: Readonly<Record<string, TaskCheckpoint>>;
}

export interface TaskCheckpoint {
  readonly taskId: string;
  readonly inputFrozen: boolean;
  readonly worktreePath: string | null;
  readonly branch: string | null;
  readonly inputHead: string | null;
  readonly committedCommit: string | null;
  readonly finishedCommit: string | null;
}

export function recoverRunCheckpoints(events: readonly RunEvent[]): RunCheckpoints {
  const tasks: Record<string, MutableTaskCheckpoint> = {};
  let terminal: RunCheckpoints["terminal"] = null;
  let blockedReason: string | null = null;

  for (const event of events) {
    if (event.type === "run.done") {
      terminal = "DONE";
      continue;
    }

    if (event.type === "run.blocked") {
      terminal = "BLOCKED";
      blockedReason = readString(event.payload.reason) ?? readString(event.payload.code);
      continue;
    }

    const taskId = readString(event.payload.taskId);
    if (!taskId) {
      continue;
    }

    const task = (tasks[taskId] ??= {
      taskId,
      inputFrozen: false,
      worktreePath: null,
      branch: null,
      inputHead: null,
      committedCommit: null,
      finishedCommit: null
    });

    switch (event.type) {
      case "task.input-frozen":
        task.inputFrozen = true;
        break;
      case "task.worktree-created":
        task.worktreePath = readString(event.payload.path);
        task.branch = readString(event.payload.branch);
        task.inputHead = readString(event.payload.inputHead);
        break;
      case "task.committed":
        task.committedCommit = readString(event.payload.commit);
        break;
      case "task.finished":
        task.finishedCommit = readString(event.payload.commit);
        break;
    }
  }

  return {
    terminal,
    blockedReason,
    tasks
  };
}

interface MutableTaskCheckpoint {
  taskId: string;
  inputFrozen: boolean;
  worktreePath: string | null;
  branch: string | null;
  inputHead: string | null;
  committedCommit: string | null;
  finishedCommit: string | null;
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}
