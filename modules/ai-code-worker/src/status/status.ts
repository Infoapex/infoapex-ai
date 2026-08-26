import { join } from "node:path";
import { gitPreflight } from "../git/preflight.js";
import { EventLog } from "../persistence/event-log.js";
import { evaluateLease, type LeaseStatus } from "../persistence/lease.js";
import { replayRun, type RunReplay } from "../persistence/replay.js";
import { resolveStateRoot } from "../state/state-root.js";
import { assertSafeWorkerRunId } from "../state/run-id.js";

export interface StatusOptions {
  readonly repositoryPath: string;
  readonly runId: string;
  readonly now?: string;
  readonly maximumHeartbeatAgeMs?: number;
}

export interface StatusReport {
  readonly status: "PASS" | "WARN" | "BLOCKED";
  readonly run: RunReplay;
  readonly eventLog: {
    readonly path: string;
    readonly eventCount: number;
    readonly ignoredTailLines: number;
  };
  readonly lease: LeaseStatus;
  readonly findings: readonly StatusFinding[];
}

export interface StatusFinding {
  readonly severity: "warning" | "blocker";
  readonly code: string;
  readonly message: string;
}

export function runStatus(options: StatusOptions): StatusReport {
  try {
    assertSafeWorkerRunId(options.runId);
  } catch (error) {
    return blockedStatus(
      options.runId,
      "RUN_ID_INVALID",
      error instanceof Error ? error.message : String(error)
    );
  }

  const repository = gitPreflight(options.repositoryPath);

  if (!repository.ok) {
    return blockedStatus(options.runId, "GIT_PREFLIGHT_FAILED", repository.reason);
  }

  const stateRoot = resolveStateRoot({ repoRoot: repository.worktreeRoot });
  const runRoot = join(stateRoot.path, "runs", options.runId);
  const eventLog = new EventLog(join(runRoot, "events.jsonl"));
  const readResult = eventLog.read();
  const run = replayRun(readResult.events);
  const lease = evaluateLease(
    join(runRoot, "lease.json"),
    options.now ?? new Date().toISOString(),
    options.maximumHeartbeatAgeMs ?? 120000
  );
  const findings: StatusFinding[] = [];

  if (readResult.ignoredTailLines.length > 0) {
    findings.push({
      severity: "warning",
      code: "EVENT_LOG_TRUNCATED_TAIL",
      message: "Ignored an incomplete trailing event log line."
    });
  }

  if (run.status === "EMPTY") {
    findings.push({
      severity: "warning",
      code: "RUN_NOT_FOUND",
      message: `No events found for run ${options.runId}.`
    });
  }

  if (run.runId && run.runId !== options.runId) {
    findings.push({
      severity: "blocker",
      code: "RUN_ID_MISMATCH",
      message: `Event log belongs to ${run.runId}, not ${options.runId}.`
    });
  }

  if (lease.state === "active") {
    findings.push({
      severity: "warning",
      code: "LEASE_ACTIVE",
      message: "A coordinator lease is currently active."
    });
  }

  const status = findings.some((finding) => finding.severity === "blocker")
    ? "BLOCKED"
    : findings.length > 0
      ? "WARN"
      : "PASS";

  return {
    status,
    run,
    eventLog: {
      path: eventLog.path,
      eventCount: readResult.events.length,
      ignoredTailLines: readResult.ignoredTailLines.length
    },
    lease,
    findings
  };
}

function blockedStatus(runId: string, code: string, message: string): StatusReport {
  return {
    status: "BLOCKED",
    run: {
      runId,
      status: "EMPTY",
      lastSequence: null,
      lastEventType: null,
      taskStates: {},
      gateStates: {},
      blockedReason: null
    },
    eventLog: {
      path: "",
      eventCount: 0,
      ignoredTailLines: 0
    },
    lease: {
      state: "missing",
      lease: null
    },
    findings: [
      {
        severity: "blocker",
        code,
        message
      }
    ]
  };
}
