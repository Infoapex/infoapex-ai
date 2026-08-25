import type { Capability, RunAuthorization } from "../authorization/run-authorization.js";

export type InstructionSourceKind =
  | "external-policy"
  | "run-authorization"
  | "frozen-manifest"
  | "accepted-plan"
  | "worker-role"
  | "repository-instructions"
  | "untrusted-data";

export type TrustPolicyRejectionCode =
  | "CAPABILITY_ESCALATION"
  | "CAPABILITY_FORBIDDEN"
  | "PATH_SCOPE_ESCALATION";

export interface InstructionContribution {
  readonly source: InstructionSourceKind;
  readonly label: string;
  readonly allowedCapabilities?: readonly Capability[];
  readonly forbiddenCapabilities?: readonly Capability[];
  readonly allowedPaths?: readonly string[];
  readonly requiredChecks?: readonly string[];
}

export interface InstructionTrustPolicyInput {
  readonly authorization: Pick<RunAuthorization, "allowedCapabilities" | "forbiddenCapabilities">;
  readonly manifestAllowedPaths: readonly string[];
  readonly manifestRequiredChecks?: readonly string[];
  readonly contributions: readonly InstructionContribution[];
}

export interface EffectiveInstructionPolicy {
  readonly allowedCapabilities: readonly Capability[];
  readonly forbiddenCapabilities: readonly Capability[];
  readonly allowedPaths: readonly string[];
  readonly requiredChecks: readonly string[];
  readonly rejections: readonly TrustPolicyRejection[];
}

export interface TrustPolicyRejection {
  readonly code: TrustPolicyRejectionCode;
  readonly source: InstructionSourceKind;
  readonly label: string;
  readonly value: string;
  readonly message: string;
}

export function applyInstructionTrustPolicy(input: InstructionTrustPolicyInput): EffectiveInstructionPolicy {
  let allowedCapabilities = sortUnique(input.authorization.allowedCapabilities);
  const forbiddenCapabilities = new Set(input.authorization.forbiddenCapabilities);
  let allowedPaths = sortUnique(input.manifestAllowedPaths.map(normalizePathPattern));
  const requiredChecks = new Set(input.manifestRequiredChecks ?? []);
  const rejections: TrustPolicyRejection[] = [];

  for (const contribution of input.contributions) {
    for (const capability of contribution.forbiddenCapabilities ?? []) {
      forbiddenCapabilities.add(capability);
    }

    if (contribution.allowedCapabilities) {
      const nextAllowedCapabilities: Capability[] = [];

      for (const capability of sortUnique(contribution.allowedCapabilities)) {
        if (forbiddenCapabilities.has(capability)) {
          rejections.push(rejection("CAPABILITY_FORBIDDEN", contribution, capability));
          continue;
        }

        if (!allowedCapabilities.includes(capability)) {
          rejections.push(rejection("CAPABILITY_ESCALATION", contribution, capability));
          continue;
        }

        nextAllowedCapabilities.push(capability);
      }

      allowedCapabilities = nextAllowedCapabilities;
    }

    if (contribution.allowedPaths) {
      const requestedPaths = sortUnique(contribution.allowedPaths.map(normalizePathPattern));
      const nextAllowedPaths: string[] = [];

      for (const requestedPath of requestedPaths) {
        if (!allowedPaths.some((allowedPath) => pathPatternContains(allowedPath, requestedPath))) {
          rejections.push(rejection("PATH_SCOPE_ESCALATION", contribution, requestedPath));
          continue;
        }

        nextAllowedPaths.push(requestedPath);
      }

      allowedPaths = nextAllowedPaths;
    }

    for (const check of contribution.requiredChecks ?? []) {
      requiredChecks.add(check);
    }

    allowedCapabilities = allowedCapabilities.filter((capability) => !forbiddenCapabilities.has(capability));
  }

  return {
    allowedCapabilities: sortUnique(allowedCapabilities),
    forbiddenCapabilities: sortUnique([...forbiddenCapabilities]),
    allowedPaths: sortUnique(allowedPaths),
    requiredChecks: sortUnique([...requiredChecks]),
    rejections
  };
}

function pathPatternContains(allowedPattern: string, requestedPattern: string): boolean {
  if (allowedPattern === requestedPattern) {
    return true;
  }

  const allowedPrefix = globPrefix(allowedPattern);
  const requestedPrefix = globPrefix(requestedPattern);

  return requestedPrefix === allowedPrefix || requestedPrefix.startsWith(`${allowedPrefix}/`);
}

function globPrefix(pattern: string): string {
  if (pattern.endsWith("/**")) {
    return pattern.slice(0, -3);
  }

  return pattern;
}

function normalizePathPattern(pattern: string): string {
  return pattern.replaceAll("\\", "/").replace(/\/+/g, "/").replace(/^\.\//, "").replace(/\/$/, "");
}

function sortUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

function rejection(
  code: TrustPolicyRejectionCode,
  contribution: InstructionContribution,
  value: string
): TrustPolicyRejection {
  return {
    code,
    source: contribution.source,
    label: contribution.label,
    value,
    message: `${contribution.label} cannot ${describeRejection(code)}: ${value}`
  };
}

function describeRejection(code: TrustPolicyRejectionCode): string {
  switch (code) {
    case "CAPABILITY_ESCALATION":
      return "grant an unauthorized capability";
    case "CAPABILITY_FORBIDDEN":
      return "allow a forbidden capability";
    case "PATH_SCOPE_ESCALATION":
      return "expand the allowed path scope";
  }
}
