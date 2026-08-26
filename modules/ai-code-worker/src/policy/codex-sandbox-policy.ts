import { randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  linkSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync
} from "node:fs";
import { dirname, join } from "node:path";
import { prepareReportText } from "../runner/redaction.js";
import { SchemaRegistry } from "../schema/json-schema.js";

export type CodexSandboxMode = "workspace-write" | "danger-full-access";
export type CodexSandboxAuthorizationSource = "cli" | "api";

export interface CodexDangerFullAccessApproval {
  readonly approved: true;
  readonly authorizedBy: string;
  readonly reason: string;
  readonly approvedAt: string;
  readonly source: CodexSandboxAuthorizationSource;
}

export interface CodexSandboxAuthorizationRecord {
  readonly authorizedBy: string;
  readonly reason: string;
  readonly reasonRedacted: boolean;
  readonly reasonSha256: string;
  readonly approvedAt: string;
  readonly source: CodexSandboxAuthorizationSource;
}

export interface CodexSandboxDecision {
  readonly schemaVersion: "1.0";
  readonly mode: CodexSandboxMode;
  readonly status: "RESTRICTED" | "AUTHORIZED" | "BLOCKED";
  readonly elevated: boolean;
  readonly authorization: CodexSandboxAuthorizationRecord | null;
  readonly blockedReason: string | null;
}

export interface CodexSandboxPolicyInput {
  readonly sandboxMode?: CodexSandboxMode;
  readonly dangerFullAccessApproval?: CodexDangerFullAccessApproval;
}

export class CodexSandboxPolicyError extends Error {
  readonly code = "CODEX_DANGER_FULL_ACCESS_UNAUTHORIZED";

  constructor(message: string) {
    super(message);
    this.name = "CodexSandboxPolicyError";
  }
}

/**
 * Resolves the effective Codex sandbox without ever escalating implicitly.
 * `workspace-write` is the writer default. `danger-full-access` is fail-closed
 * unless a caller supplies a complete, attributable approval record.
 */
export function evaluateCodexSandboxPolicy(input: CodexSandboxPolicyInput): CodexSandboxDecision {
  const mode = input.sandboxMode ?? "workspace-write";

  if (mode === "workspace-write") {
    return {
      schemaVersion: "1.0",
      mode,
      status: "RESTRICTED",
      elevated: false,
      authorization: null,
      blockedReason: null
    };
  }

  const approval = input.dangerFullAccessApproval;
  if (!isValidApproval(approval)) {
    return {
      schemaVersion: "1.0",
      mode,
      status: "BLOCKED",
      elevated: true,
      authorization: null,
      blockedReason:
        "Codex danger-full-access requires an explicit approval with authorizedBy, reason, approvedAt, and provenance source."
    };
  }

  const preparedReason = prepareReportText(approval.reason.trim(), 1_000);
  return {
    schemaVersion: "1.0",
    mode,
    status: "AUTHORIZED",
    elevated: true,
    authorization: {
      authorizedBy: approval.authorizedBy.trim(),
      reason: preparedReason.text,
      reasonRedacted: preparedReason.redacted,
      reasonSha256: preparedReason.sha256,
      approvedAt: new Date(Date.parse(approval.approvedAt)).toISOString(),
      source: approval.source
    },
    blockedReason: null
  };
}

export function assertCodexSandboxAuthorized(input: CodexSandboxPolicyInput): CodexSandboxDecision {
  const decision = evaluateCodexSandboxPolicy(input);
  if (decision.status === "BLOCKED") {
    throw new CodexSandboxPolicyError(decision.blockedReason ?? "Codex sandbox policy blocked execution.");
  }
  return decision;
}

/** Every provenance field, including approvedAt, participates in the immutable
 * run binding. Changing an elevation grant requires a new run. */
export function sameCodexSandboxAuthorization(
  left: CodexSandboxDecision,
  right: CodexSandboxDecision
): boolean {
  return (
    left.mode === right.mode &&
    left.status === right.status &&
    left.elevated === right.elevated &&
    left.blockedReason === right.blockedReason &&
    left.authorization?.authorizedBy === right.authorization?.authorizedBy &&
    left.authorization?.reason === right.authorization?.reason &&
    left.authorization?.reasonRedacted === right.authorization?.reasonRedacted &&
    left.authorization?.reasonSha256 === right.authorization?.reasonSha256 &&
    left.authorization?.approvedAt === right.authorization?.approvedAt &&
    left.authorization?.source === right.authorization?.source
  );
}

export type CodexSandboxBindingResult =
  | { readonly status: "PASS" }
  | { readonly status: "BLOCKED"; readonly message: string };

/** Publishes the effective sandbox decision once per run. A pre-existing
 * decision is accepted only when every normalized authorization field is
 * identical; malformed or conflicting state is never replaced. */
export function bindCodexSandboxDecision(
  runRoot: string,
  decision: CodexSandboxDecision,
  registry = SchemaRegistry.load()
): CodexSandboxBindingResult {
  const path = join(runRoot, "sandbox-policy.json");
  registry.assertValid("codex-sandbox-policy.schema.json", decision);

  if (existsSync(path)) {
    return compareExistingCodexSandboxDecision(path, decision, registry);
  }

  const temporaryPath = join(dirname(path), `.sandbox-policy-${randomUUID()}.tmp`);
  let descriptor: number | null = null;

  try {
    descriptor = openSync(temporaryPath, "wx", 0o600);
    writeFileSync(descriptor, `${JSON.stringify(decision, null, 2)}\n`, "utf8");
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = null;
    linkSync(temporaryPath, path);
    return { status: "PASS" };
  } catch (error) {
    if (existsSync(path)) {
      return compareExistingCodexSandboxDecision(path, decision, registry);
    }
    return {
      status: "BLOCKED",
      message: `Unable to bind the immutable Codex sandbox decision: ${error instanceof Error ? error.message : String(error)}`
    };
  } finally {
    if (descriptor !== null) closeSync(descriptor);
    if (existsSync(temporaryPath)) unlinkSync(temporaryPath);
  }
}

function compareExistingCodexSandboxDecision(
  path: string,
  decision: CodexSandboxDecision,
  registry: SchemaRegistry
): CodexSandboxBindingResult {
  try {
    const existing = JSON.parse(readFileSync(path, "utf8")) as CodexSandboxDecision;
    registry.assertValid("codex-sandbox-policy.schema.json", existing);
    if (sameCodexSandboxAuthorization(existing, decision)) {
      return { status: "PASS" };
    }
    return {
      status: "BLOCKED",
      message:
        "The run is already bound to a different Codex sandbox decision. Start a new run to change sandbox mode or authorization provenance."
    };
  } catch (error) {
    return {
      status: "BLOCKED",
      message: `The existing Codex sandbox decision is unreadable or invalid; it will not be replaced: ${error instanceof Error ? error.message : String(error)}`
    };
  }
}

function isValidApproval(value: CodexDangerFullAccessApproval | undefined): value is CodexDangerFullAccessApproval {
  if (!value || value.approved !== true) {
    return false;
  }

  const actor = value.authorizedBy.trim();
  const reason = value.reason.trim();
  return (
    actor.length > 0 &&
    actor.length <= 128 &&
    !/[\r\n\0]/.test(actor) &&
    reason.length > 0 &&
    Number.isFinite(Date.parse(value.approvedAt)) &&
    (value.source === "cli" || value.source === "api")
  );
}
