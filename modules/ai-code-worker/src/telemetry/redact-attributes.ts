import { redactText } from "../runner/redaction.js";

// Matches OpenTelemetry's own AttributeValue exactly (mutable, homogeneous arrays) so
// callers can assign this straight into a Span's Attributes without a cast.
export type SpanAttributeValue = string | number | boolean | string[] | number[] | boolean[];

/**
 * Payload keys already established by the event log as safe (IDs, hashes, enums,
 * exit codes, counts, durations - never prompts, file contents, env vars, or raw
 * command output; see docs/adr/0012-redacted-opentelemetry-tracing.md's threat model).
 * Kept as an allowlist, not a denylist, so a payload field neither of us has reviewed
 * yet is dropped by default instead of silently exported.
 */
const ALLOWED_ATTRIBUTE_KEYS = new Set([
  "taskId",
  "gateId",
  "runId",
  "commit",
  "parent",
  "exitCode",
  "failureClass",
  "outputSha256",
  "scope",
  "status",
  "code",
  "executionId",
  "sessionId",
  "intentId",
  "baseCommit",
  "planSha256",
  "manifestSha256",
  "authorizationId",
  "snapshotMetadataSha256",
  "contextDigest",
  "packageId",
  "headCommit",
  "branch",
  "maximumParallelWriters",
  "maximumRepairCycles",
  "repairTaskId",
  "cycle",
  "attempt",
  "outcome",
  "sourceMapDigest",
  "traceCoveragePercent",
  "complete",
  "coverageRows",
  "findings",
  "stopReason",
  "taskIds",
  "tasks"
]);

/**
 * Fields whose raw value is a filesystem path or an array of them (worktree paths,
 * changed-file paths) - the one leak class the event log itself does not scrub, since a
 * Windows/`$HOME`-style path can embed a local username. Never passed through; recorded
 * only as a count under the renamed key, so span attributes gain "how many files
 * changed" without ever gaining "which files, where."
 */
const COUNT_ONLY_KEYS: Readonly<Record<string, string>> = {
  changedPaths: "changedPathCount"
};

export function toSpanAttributes(payload: Readonly<Record<string, unknown>>): Record<string, SpanAttributeValue> {
  const attributes: Record<string, SpanAttributeValue> = {};

  for (const [key, value] of Object.entries(payload)) {
    const countKey = COUNT_ONLY_KEYS[key];
    if (countKey) {
      if (Array.isArray(value)) {
        attributes[countKey] = value.length;
      }
      continue;
    }

    if (!ALLOWED_ATTRIBUTE_KEYS.has(key)) {
      continue;
    }

    const attributeValue = toAttributeValue(value);
    if (attributeValue !== undefined) {
      attributes[key] = attributeValue;
    }
  }

  return attributes;
}

function toAttributeValue(value: unknown): SpanAttributeValue | undefined {
  if (typeof value === "number" || typeof value === "boolean") {
    return value;
  }

  if (typeof value === "string") {
    const { text, redacted } = redactText(value);
    // Defense in depth: an allowlisted key should never carry a secret-shaped value,
    // but if one somehow does, drop the attribute entirely rather than export the
    // "[REDACTED]" placeholder, which would still confirm a secret was present.
    return redacted ? undefined : text;
  }

  if (Array.isArray(value) && value.length > 0) {
    if (value.every((item): item is string => typeof item === "string")) {
      return value.some((item) => redactText(item).redacted) ? undefined : [...value];
    }
    if (value.every((item): item is number => typeof item === "number")) {
      return [...value];
    }
    if (value.every((item): item is boolean => typeof item === "boolean")) {
      return [...value];
    }
  }

  return undefined;
}
