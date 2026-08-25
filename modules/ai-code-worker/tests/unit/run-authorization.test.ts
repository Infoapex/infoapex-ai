import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import {
  AuthorizationBindingError,
  assertCapability,
  bindRunAuthorization,
  type RunIntent
} from "../../src/authorization/run-authorization.js";
import { freezeManifest, sha256, canonicalJson } from "../../src/manifest/normalize.js";
import { SchemaRegistry, type JsonValue } from "../../src/schema/json-schema.js";

const registry = SchemaRegistry.load({ schemaDirectory: "schemas" });
const issuedAt = "2026-08-01T10:00:00Z";
const repositoryFingerprint = "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff";

describe("run authorization binding", () => {
  it("binds authorization to manifest, base commit, graph version, and execution profile digest", () => {
    const manifest = readJson("tests/fixtures/manifest/valid-minimal.json");
    const profile = readJson("templates/project/.ai-code-worker/execution-environment.example.json");
    const authorization = bindRunAuthorization({
      authorizationId: "auth_phase0_001",
      intent: matchingIntent(),
      manifest,
      executionProfile: profile,
      repositoryFingerprint,
      issuedAt,
      registry
    });

    assert.equal(authorization.runId, "run_phase0_001");
    assert.equal(authorization.manifestSha256, freezeManifest(manifest, registry).sha256);
    assert.equal(authorization.baseCommit, "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb");
    assert.equal(authorization.graphVersion, 1);
    assert.equal(authorization.executionEnvironment.profileSha256, sha256(canonicalJson(profile as JsonValue)));
    assert.deepEqual(authorization.allowedCapabilities, [
      "create-local-commits",
      "run-isolated-tests",
      "write-worktree"
    ]);
    assert.deepEqual(registry.validate("run-authorization.schema.json", authorization), { valid: true, errors: [] });
  });

  it("rejects a manifest whose plan hash does not match the intent", () => {
    const manifest = readJson("tests/fixtures/manifest/valid-minimal.json") as Record<string, unknown>;
    const changedManifest = {
      ...manifest,
      plan: {
        ...(manifest.plan as Record<string, unknown>),
        sha256: "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"
      }
    };

    assertBindingError(
      () =>
        bindRunAuthorization({
          authorizationId: "auth_phase0_002",
          intent: matchingIntent(),
          manifest: changedManifest,
          executionProfile: readJson("templates/project/.ai-code-worker/execution-environment.example.json"),
          repositoryFingerprint,
          issuedAt,
          registry
        }),
      "AUTHORIZATION_MISMATCH"
    );
  });

  it("blocks missing or forbidden capabilities after binding", () => {
    const authorization = bindRunAuthorization({
      authorizationId: "auth_phase0_003",
      intent: matchingIntent(),
      manifest: readJson("tests/fixtures/manifest/valid-minimal.json"),
      executionProfile: readJson("templates/project/.ai-code-worker/execution-environment.example.json"),
      repositoryFingerprint,
      issuedAt,
      registry
    });

    assert.doesNotThrow(() => assertCapability(authorization, "write-worktree"));
    assertBindingError(() => assertCapability(authorization, "network-write"), "CAPABILITY_FORBIDDEN");
    assertBindingError(() => assertCapability(authorization, "read-secrets"), "CAPABILITY_NOT_GRANTED");
  });

  it("rejects expired intents before writer authorization exists", () => {
    assertBindingError(
      () =>
        bindRunAuthorization({
          authorizationId: "auth_phase0_004",
          intent: {
            ...matchingIntent(),
            expiresAt: "2026-08-01T09:59:59Z"
          },
          manifest: readJson("tests/fixtures/manifest/valid-minimal.json"),
          executionProfile: readJson("templates/project/.ai-code-worker/execution-environment.example.json"),
          repositoryFingerprint,
          issuedAt,
          registry
        }),
      "AUTHORIZATION_EXPIRED"
    );
  });

  it("rejects execution profile kind drift", () => {
    const profile = {
      ...(readJson("templates/project/.ai-code-worker/execution-environment.example.json") as Record<string, unknown>),
      kind: "trusted-local"
    };

    assertBindingError(
      () =>
        bindRunAuthorization({
          authorizationId: "auth_phase0_005",
          intent: matchingIntent(),
          manifest: readJson("tests/fixtures/manifest/valid-minimal.json"),
          executionProfile: profile,
          repositoryFingerprint,
          issuedAt,
          registry
        }),
      "AUTHORIZATION_MISMATCH"
    );
  });

  it("rejects repository fingerprint drift", () => {
    assertBindingError(
      () =>
        bindRunAuthorization({
          authorizationId: "auth_phase0_006",
          intent: matchingIntent(),
          manifest: readJson("tests/fixtures/manifest/valid-minimal.json"),
          executionProfile: readJson("templates/project/.ai-code-worker/execution-environment.example.json"),
          repositoryFingerprint: "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
          issuedAt,
          registry
        }),
      "AUTHORIZATION_MISMATCH"
    );
  });
});

function matchingIntent(): RunIntent {
  return {
    schemaVersion: "1.0",
    intentId: "intent_phase0_001",
    runId: "run_phase0_001",
    planPath: "Plan/ACCEPTED.md",
    planSha256: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    baseRef: "main",
    baseCommit: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    repositoryFingerprint,
    requestedCapabilities: ["write-worktree", "run-isolated-tests", "create-local-commits"],
    forbiddenCapabilities: ["push", "deploy", "network-write"],
    approvalMode: "never",
    executionEnvironmentKind: "isolated",
    limits: {
      maximumRunMinutes: 30,
      maximumAgentInvocations: 1,
      maximumInputUncachedTokens: 100000,
      maximumCacheReadTokens: 100000,
      maximumCacheWriteTokens: 100000,
      maximumOutputTokens: 20000,
      maximumCostUsd: null
    },
    createdAt: "2026-08-01T09:55:00Z",
    expiresAt: "2026-08-01T10:30:00Z"
  };
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8"));
}

function assertBindingError(fn: () => unknown, code: AuthorizationBindingError["code"]): void {
  assert.throws(fn, (error) => error instanceof AuthorizationBindingError && error.code === code);
}
