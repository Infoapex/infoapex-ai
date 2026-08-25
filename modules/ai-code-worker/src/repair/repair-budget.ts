export type RepairBudgetStopReason =
  | "repeated-failure-no-progress"
  | "scope-expansion-required"
  | "cycles-exhausted"
  | "time-exhausted"
  | "usage-exhausted"
  | "cost-exhausted"
  | null;

export interface RepairBudget {
  readonly schemaVersion: "1.0";
  readonly runId: string;
  readonly maximumRepairCycles: number;
  readonly consumedCycles: number;
  readonly remainingCycles: number;
  readonly stopReason: RepairBudgetStopReason;
  readonly updatedAt: string;
}
