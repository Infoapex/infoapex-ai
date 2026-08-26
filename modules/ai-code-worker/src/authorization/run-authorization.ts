import { canonicalJson, freezeManifest, sha256 } from "../manifest/normalize.js";
import { SchemaRegistry, type JsonValue } from "../schema/json-schema.js";
import type { TrustedLocalAuthorizationRecord } from "../execution/environment.js";

export type ApprovalMode = "never" | "on-risk" | "always";
export type Capability = string;
export type ExecutionEnvironmentKind = "isolated" | "trusted-local";

export interface RunIntent {
  readonly schemaVersion: "1.0";
  readonly intentId: string;
  readonly runId: string;
  readonly planPath: string;
  readonly planSha256: string;
  readonly baseRef: string;
  readonly baseCommit: string;
  readonly repositoryFingerprint: string;
  readonly requestedCapabilities: readonly Capability[];
  readonly forbiddenCapabilities: readonly Capability[];
  readonly approvalMode: ApprovalMode;
  readonly executionEnvironmentKind: ExecutionEnvironmentKind;
  readonly trustedLocalAuthorization?: TrustedLocalAuthorizationRecord;
  readonly limits: AuthorizationLimits;
  readonly createdAt: string;
  readonly expiresAt: string;
}

export interface AuthorizationLimits {
  readonly maximumRunMinutes: number;
  readonly maximumAgentInvocations: number;
  readonly maximumInputUncachedTokens: number | null;
  readonly maximumCacheReadTokens: number | null;
  readonly maximumCacheWriteTokens: number | null;
  readonly maximumOutputTokens: number | null;
  readonly maximumCostUsd: number | null;
}

export interface RunAuthorization {
  readonly schemaVersion: "1.0";
  readonly authorizationId: string;
  readonly runId: string;
  readonly repositoryFingerprint: string;
  readonly planSha256: string;
  readonly manifestSha256: string;
  readonly baseCommit: string;
  readonly graphVersion: number;
  readonly executionEnvironment: {
    readonly profileId: string;
    readonly kind: ExecutionEnvironmentKind;
    readonly profileSha256: string;
  };
  readonly trustedLocalAuthorization?: TrustedLocalAuthorizationRecord;
  readonly allowedCapabilities: readonly Capability[];
  readonly forbiddenCapabilities: readonly Capability[];
  readonly approvalMode: ApprovalMode;
  readonly limits: AuthorizationLimits;
  readonly issuedAt: string;
  readonly expiresAt: string;
}

export interface BindRunAuthorizationInput {
  readonly authorizationId: string;
  readonly intent: unknown;
  readonly manifest: unknown;
  readonly executionProfile: unknown;
  readonly repositoryFingerprint: string;
  readonly issuedAt: string;
  readonly registry?: SchemaRegistry;
}

export class AuthorizationBindingError extends Error {
  constructor(
    readonly code: AuthorizationBindingErrorCode,
    message: string
  ) {
    super(message);
    this.name = "AuthorizationBindingError";
  }
}

export type AuthorizationBindingErrorCode =
  | "AUTHORIZATION_MISMATCH"
  | "CAPABILITY_NOT_GRANTED"
  | "CAPABILITY_FORBIDDEN"
  | "AUTHORIZATION_EXPIRED";

export function bindRunAuthorization(input: BindRunAuthorizationInput): RunAuthorization {
  const registry = input.registry ?? SchemaRegistry.load();

  registry.assertValid("run-intent.schema.json", input.intent);
  registry.assertValid("execution-environment.schema.json", input.executionProfile);

  const intent = input.intent as RunIntent;
  const manifest = input.manifest as ManifestView;
  const profile = input.executionProfile as ExecutionProfileView;
  const frozenManifest = freezeManifest(input.manifest, registry);
  const profileSha256 = sha256(canonicalJson(input.executionProfile as JsonValue));

  assertNotExpired(intent, input.issuedAt);
  assertEqual("runId", intent.runId, manifest.runId);
  assertEqual("planSha256", intent.planSha256, manifest.plan.sha256);
  assertEqual("baseCommit", intent.baseCommit, manifest.base.commit);
  assertEqual("repositoryFingerprint", intent.repositoryFingerprint, input.repositoryFingerprint);
  assertEqual("executionEnvironmentKind", intent.executionEnvironmentKind, profile.kind);

  if (profile.kind === "trusted-local" && intent.trustedLocalAuthorization === undefined) {
    throw new AuthorizationBindingError(
      "CAPABILITY_NOT_GRANTED",
      "trusted-local execution requires an explicit external authorization record."
    );
  }
  if (profile.kind === "isolated" && intent.trustedLocalAuthorization !== undefined) {
    throw new AuthorizationBindingError(
      "AUTHORIZATION_MISMATCH",
      "A trusted-local authorization cannot be bound to an isolated execution profile."
    );
  }

  const allowedCapabilities = sortUnique(intent.requestedCapabilities);
  const forbiddenCapabilities = sortUnique(intent.forbiddenCapabilities);

  for (const capability of allowedCapabilities) {
    if (forbiddenCapabilities.includes(capability)) {
      throw new AuthorizationBindingError(
        "CAPABILITY_FORBIDDEN",
        `Capability is both requested and forbidden: ${capability}`
      );
    }
  }

  const authorization: RunAuthorization = {
    schemaVersion: "1.0",
    authorizationId: input.authorizationId,
    runId: intent.runId,
    repositoryFingerprint: intent.repositoryFingerprint,
    planSha256: intent.planSha256,
    manifestSha256: frozenManifest.sha256,
    baseCommit: intent.baseCommit,
    graphVersion: manifest.graphVersion,
    executionEnvironment: {
      profileId: profile.profileId,
      kind: profile.kind,
      profileSha256
    },
    ...(intent.trustedLocalAuthorization !== undefined
      ? { trustedLocalAuthorization: intent.trustedLocalAuthorization }
      : {}),
    allowedCapabilities,
    forbiddenCapabilities,
    approvalMode: intent.approvalMode,
    limits: intent.limits,
    issuedAt: input.issuedAt,
    expiresAt: intent.expiresAt
  };

  registry.assertValid("run-authorization.schema.json", authorization);

  return authorization;
}

export function assertCapability(authorization: RunAuthorization, capability: Capability): void {
  if (authorization.forbiddenCapabilities.includes(capability)) {
    throw new AuthorizationBindingError("CAPABILITY_FORBIDDEN", `Capability is forbidden: ${capability}`);
  }

  if (!authorization.allowedCapabilities.includes(capability)) {
    throw new AuthorizationBindingError("CAPABILITY_NOT_GRANTED", `Capability is not granted: ${capability}`);
  }
}

interface ManifestView {
  readonly runId: string;
  readonly graphVersion: number;
  readonly plan: {
    readonly sha256: string;
  };
  readonly base: {
    readonly commit: string;
  };
}

interface ExecutionProfileView {
  readonly profileId: string;
  readonly kind: ExecutionEnvironmentKind;
}

function assertNotExpired(intent: RunIntent, issuedAt: string): void {
  if (Date.parse(issuedAt) > Date.parse(intent.expiresAt)) {
    throw new AuthorizationBindingError(
      "AUTHORIZATION_EXPIRED",
      `RunIntent expired before authorization binding: ${intent.intentId}`
    );
  }
}

function assertEqual(name: string, expected: string, actual: string): void {
  if (expected !== actual) {
    throw new AuthorizationBindingError(
      "AUTHORIZATION_MISMATCH",
      `${name} mismatch: expected ${expected}, got ${actual}`
    );
  }
}

function sortUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}
