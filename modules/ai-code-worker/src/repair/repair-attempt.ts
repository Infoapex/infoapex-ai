export type RepairAttemptOutcome = "PASSED" | "FAILED" | "BLOCKED" | null;

export interface RepairAttempt {
  readonly schemaVersion: "1.0";
  readonly id: string;
  readonly repairTaskId: string;
  readonly runId: string;
  readonly cycle: number;
  readonly startedAt: string;
  readonly finishedAt: string | null;
  readonly outcome: RepairAttemptOutcome;
  readonly commit: string | null;
  readonly failureSignatureId: string | null;
  readonly evidenceRef: string | null;
}
