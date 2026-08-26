import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  assertCodexSandboxAuthorized,
  CodexSandboxPolicyError,
  evaluateCodexSandboxPolicy,
  sameCodexSandboxAuthorization
} from "../../src/policy/codex-sandbox-policy.js";
import { SchemaRegistry } from "../../src/schema/json-schema.js";

describe("Codex sandbox policy", () => {
  it("defaults writers to workspace-write without an elevation record", () => {
    const decision = evaluateCodexSandboxPolicy({});

    assert.deepEqual(decision, {
      schemaVersion: "1.0",
      mode: "workspace-write",
      status: "RESTRICTED",
      elevated: false,
      authorization: null,
      blockedReason: null
    });
    assert.deepEqual(SchemaRegistry.load({ schemaDirectory: "schemas" }).validate("codex-sandbox-policy.schema.json", decision), {
      valid: true,
      errors: []
    });
  });

  it("blocks danger-full-access without complete explicit approval", () => {
    const decision = evaluateCodexSandboxPolicy({ sandboxMode: "danger-full-access" });

    assert.equal(decision.status, "BLOCKED");
    assert.equal(decision.authorization, null);
    assert.throws(
      () => assertCodexSandboxAuthorized({ sandboxMode: "danger-full-access" }),
      (error: unknown) => error instanceof CodexSandboxPolicyError && error.code === "CODEX_DANGER_FULL_ACCESS_UNAUTHORIZED"
    );
  });

  it("authorizes an explicit elevation and preserves attributable, redacted provenance", () => {
    const decision = evaluateCodexSandboxPolicy({
      sandboxMode: "danger-full-access",
      dangerFullAccessApproval: {
        approved: true,
        authorizedBy: "release-owner",
        reason: "Provider limitation; token=abcdefghijk must not leak",
        approvedAt: "2026-08-26T09:00:00.000Z",
        source: "cli"
      }
    });

    assert.equal(decision.status, "AUTHORIZED");
    assert.equal(decision.mode, "danger-full-access");
    assert.equal(decision.authorization?.authorizedBy, "release-owner");
    assert.equal(decision.authorization?.source, "cli");
    assert.equal(decision.authorization?.reasonRedacted, true);
    assert.match(decision.authorization?.reason ?? "", /\[REDACTED\]/);
    assert.deepEqual(SchemaRegistry.load({ schemaDirectory: "schemas" }).validate("codex-sandbox-policy.schema.json", decision), {
      valid: true,
      errors: []
    });
  });

  it("keeps the approval timestamp in the immutable authorization identity", () => {
    const first = evaluateCodexSandboxPolicy({
      sandboxMode: "danger-full-access",
      dangerFullAccessApproval: {
        approved: true,
        authorizedBy: "owner",
        reason: "Controlled disposable worktree pilot",
        approvedAt: "2026-08-26T09:00:00.000Z",
        source: "api"
      }
    });
    const resumed = evaluateCodexSandboxPolicy({
      sandboxMode: "danger-full-access",
      dangerFullAccessApproval: {
        approved: true,
        authorizedBy: "owner",
        reason: "Controlled disposable worktree pilot",
        approvedAt: "2026-08-26T10:00:00.000Z",
        source: "api"
      }
    });

    assert.equal(sameCodexSandboxAuthorization(first, resumed), false);
  });

  it("rejects schema states that label danger-full-access as restricted", () => {
    const invalid = {
      schemaVersion: "1.0",
      mode: "danger-full-access",
      status: "RESTRICTED",
      elevated: false,
      authorization: null,
      blockedReason: null
    };

    assert.equal(
      SchemaRegistry.load({ schemaDirectory: "schemas" }).validate("codex-sandbox-policy.schema.json", invalid).valid,
      false
    );
  });
});
