export type RepairTaskStatus =
  | "PENDING"
  | "READY"
  | "RUNNING"
  | "VERIFYING"
  | "PASSED"
  | "BLOCKED"
  | "STALE"
  | "SUPERSEDED"
  | "CANCELLED";

export interface RepairTask {
  readonly schemaVersion: "1.0";
  readonly id: string;
  readonly runId: string;
  readonly graphVersion: number;
  readonly sourceFindingIds: readonly string[];
  readonly allowedPaths: readonly string[];
  readonly forbiddenPaths: readonly string[];
  readonly verify: readonly string[];
  readonly dependsOn: readonly string[];
  readonly maximumAttempts: number;
  readonly status: RepairTaskStatus;
  readonly createdAt: string;
}
