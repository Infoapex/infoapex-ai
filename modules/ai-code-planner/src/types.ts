export interface AcceptanceCriterion {
  criterionId: string;
  text: string;
}

export interface Gate {
  gateId: string;
  command: string;
  evidenceContract: string;
  criterionIds: string[];
}

export interface Scope {
  allowedPaths: string[];
  forbiddenPaths: string[];
}

export interface RequiredInput {
  kind: 'file' | 'symbol' | 'external';
  ref: string;
}

export interface PlanTask {
  id: string;
  goal: string;
  acceptanceCriteria: AcceptanceCriterion[];
  gates: Gate[];
  dependsOn: string[];
  scope: Scope;
  requiredInputs: RequiredInput[];
  executionProfile?: string;
  relevantSymbols?: string[];
  risk?: 'low' | 'medium' | 'high';
}

export interface Plan {
  goal: string;
  tasks: PlanTask[];
  nonGoals?: string[];
  ambiguities?: string[];
  planningProvenance?: Record<string, unknown>;
  risk?: 'low' | 'medium' | 'high';
}

export interface FindingLocation {
  file?: string;
  line?: number;
  column?: number;
  path?: string;
}

export interface FindingVerification {
  method: 'static-analysis' | 'schema-validation' | 'cross-reference' | 'human-review' | 'consensus-panel';
  evidence: string;
  verifiedBy?: string;
  verifiedAt?: string;
}

export interface Finding {
  id: string;
  type: 'unverified-claim' | 'internal-contradiction' | 'omission' | 'over-claim' | 'style';
  severity: 'blocker' | 'major' | 'minor';
  claim: string;
  status: 'proposed' | 'verified' | 'refuted' | 'accepted-as-assumption' | 'needs-human' | 'superseded';
  location?: FindingLocation;
  supersededBy?: string;
  verification?: FindingVerification;
}

export interface WorkerManifestTask {
  id: string;
  kind: string;
  role: string;
  dependsOn: string[];
  requiredInputs: string[];
  allowedPaths: string[];
  forbiddenPaths: string[];
  expectedArtifacts: string[];
  acceptanceCriteria: string[];
  verify: string[];
  concurrencyKeys: string[];
  risk: 'low' | 'medium' | 'high';
  relevantSymbols?: string[];
  executionProfile?: string;
}

export interface WorkerTaskTraceability {
  acceptanceCriteria: AcceptanceCriterion[];
  gates: Gate[];
}

export interface WorkerManifestTaskV1_1 extends WorkerManifestTask {
  traceability: WorkerTaskTraceability;
}

export interface ProjectionWarning {
  taskId: string;
  lostFields: string[];
}
