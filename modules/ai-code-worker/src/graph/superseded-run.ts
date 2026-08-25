export interface SupersededRun {
  readonly schemaVersion: "1.0";
  readonly runId: string;
  readonly supersededByRunId: string;
  readonly supersededByGraphVersion: number;
  readonly reason: string;
  readonly supersededAt: string;
}
