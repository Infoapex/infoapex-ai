export interface GraphRevision {
  readonly schemaVersion: "1.0";
  readonly runId: string;
  readonly graphVersion: number;
  readonly previousGraphVersion: number | null;
  readonly supersedesRunId: string | null;
  readonly reason: string;
  readonly manifestSha256: string;
  readonly authorizationId: string;
  readonly createdAt: string;
}
