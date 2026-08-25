export type FailureSignatureSourceType = "gate" | "finding";

export interface RepeatedFailureSignature {
  readonly schemaVersion: "1.0";
  readonly id: string;
  readonly runId: string;
  readonly sourceType: FailureSignatureSourceType;
  readonly sourceId: string;
  readonly signatureHash: string;
  readonly occurrenceCount: number;
  readonly firstSeenAt: string;
  readonly lastSeenAt: string;
  readonly progressDetected: boolean;
}
