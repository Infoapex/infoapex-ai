import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { createGraphRevision, GraphRevisionError } from "../../src/graph/create-graph-revision.js";
import type { RunAuthorization } from "../../src/authorization/run-authorization.js";
import { freezeManifest } from "../../src/manifest/normalize.js";
import { SchemaRegistry } from "../../src/schema/json-schema.js";

const registry = SchemaRegistry.load({ schemaDirectory: "schemas" });

function baseManifest(): Record<string, unknown> {
  return JSON.parse(readFileSync("tests/fixtures/manifest/valid-minimal.json", "utf8")) as Record<string, unknown>;
}

function manifestWith(overrides: Record<string, unknown>): Record<string, unknown> {
  return { ...baseManifest(), ...overrides };
}

function authorizationFor(manifest: Record<string, unknown>, authorizationId: string): RunAuthorization {
  const frozen = freezeManifest(manifest, registry);

  return {
    schemaVersion: "1.0",
    authorizationId,
    runId: manifest.runId as string,
    repositoryFingerprint: "a".repeat(64),
    planSha256: "b".repeat(64),
    manifestSha256: frozen.sha256,
    baseCommit: "c".repeat(40),
    graphVersion: manifest.graphVersion as number,
    executionEnvironment: { profileId: "isolated", kind: "isolated", profileSha256: "d".repeat(64) },
    allowedCapabilities: ["write-worktree"],
    forbiddenCapabilities: ["push"],
    approvalMode: "never",
    limits: {
      maximumRunMinutes: 30,
      maximumAgentInvocations: 1,
      maximumInputUncachedTokens: 1000,
      maximumCacheReadTokens: 1000,
      maximumCacheWriteTokens: 1000,
      maximumOutputTokens: 1000,
      maximumCostUsd: null
    },
    issuedAt: "2026-08-14T12:00:00Z",
    expiresAt: "2026-08-14T13:00:00Z"
  };
}

describe("graph revision semantics", () => {
  it("creates a matched revision + superseded-run pair for a properly incremented, re-bound run", () => {
    const oldManifest = manifestWith({ runId: "run-old-0001", graphVersion: 1 });
    const newManifest = manifestWith({ runId: "run-new-0001", graphVersion: 2 });
    const oldFrozen = freezeManifest(oldManifest, registry);

    const result = createGraphRevision({
      supersededRun: {
        runId: "run-old-0001",
        graphVersion: 1,
        manifestSha256: oldFrozen.sha256,
        authorizationId: "auth-old-0001",
        manifest: oldManifest
      },
      newManifest,
      newAuthorization: authorizationFor(newManifest, "auth-new-0001"),
      reason: "Repair changed a dependency commit; descendants require a new snapshot.",
      now: "2026-08-14T12:30:00Z",
      registry
    });

    assert.equal(result.revision.runId, "run-new-0001");
    assert.equal(result.revision.graphVersion, 2);
    assert.equal(result.revision.previousGraphVersion, 1);
    assert.equal(result.revision.supersedesRunId, "run-old-0001");
    assert.equal(result.supersededRun.runId, "run-old-0001");
    assert.equal(result.supersededRun.supersededByRunId, "run-new-0001");
    assert.equal(result.supersededRun.supersededByGraphVersion, 2);
    assert.deepEqual(registry.validate("graph-revision.schema.json", result.revision), { valid: true, errors: [] });
    assert.deepEqual(registry.validate("superseded-run.schema.json", result.supersededRun), { valid: true, errors: [] });
  });

  it("rejects a superseded manifest whose stored hash no longer matches its content", () => {
    const oldManifest = manifestWith({ runId: "run-old-0001", graphVersion: 1 });
    const newManifest = manifestWith({ runId: "run-new-0001", graphVersion: 2 });

    assert.throws(
      () =>
        createGraphRevision({
          supersededRun: {
            runId: "run-old-0001",
            graphVersion: 1,
            manifestSha256: "0".repeat(64), // does not match oldManifest's real hash
            authorizationId: "auth-old-0001",
            manifest: oldManifest
          },
          newManifest,
          newAuthorization: authorizationFor(newManifest, "auth-new-0001"),
          reason: "test",
          registry
        }),
      (error: unknown) => error instanceof GraphRevisionError && error.code === "FROZEN_MANIFEST_MUTATED"
    );
  });

  it("rejects a new manifest that reuses the superseded run's runId", () => {
    const oldManifest = manifestWith({ runId: "run-old-0001", graphVersion: 1 });
    const newManifest = manifestWith({ runId: "run-old-0001", graphVersion: 2 });
    const oldFrozen = freezeManifest(oldManifest, registry);

    assert.throws(
      () =>
        createGraphRevision({
          supersededRun: {
            runId: "run-old-0001",
            graphVersion: 1,
            manifestSha256: oldFrozen.sha256,
            authorizationId: "auth-old-0001",
            manifest: oldManifest
          },
          newManifest,
          newAuthorization: authorizationFor(newManifest, "auth-new-0001"),
          reason: "test",
          registry
        }),
      (error: unknown) => error instanceof GraphRevisionError && error.code === "RUN_ID_UNCHANGED"
    );
  });

  it("rejects a new manifest whose graphVersion is not exactly previous + 1", () => {
    const oldManifest = manifestWith({ runId: "run-old-0001", graphVersion: 1 });
    const skippedVersionManifest = manifestWith({ runId: "run-new-0001", graphVersion: 3 });
    const oldFrozen = freezeManifest(oldManifest, registry);

    assert.throws(
      () =>
        createGraphRevision({
          supersededRun: {
            runId: "run-old-0001",
            graphVersion: 1,
            manifestSha256: oldFrozen.sha256,
            authorizationId: "auth-old-0001",
            manifest: oldManifest
          },
          newManifest: skippedVersionManifest,
          newAuthorization: authorizationFor(skippedVersionManifest, "auth-new-0001"),
          reason: "test",
          registry
        }),
      (error: unknown) => error instanceof GraphRevisionError && error.code === "GRAPH_VERSION_NOT_INCREMENTED"
    );
  });

  it("rejects an authorization that reuses the superseded run's authorizationId", () => {
    const oldManifest = manifestWith({ runId: "run-old-0001", graphVersion: 1 });
    const newManifest = manifestWith({ runId: "run-new-0001", graphVersion: 2 });
    const oldFrozen = freezeManifest(oldManifest, registry);

    assert.throws(
      () =>
        createGraphRevision({
          supersededRun: {
            runId: "run-old-0001",
            graphVersion: 1,
            manifestSha256: oldFrozen.sha256,
            authorizationId: "auth-old-0001",
            manifest: oldManifest
          },
          newManifest,
          newAuthorization: authorizationFor(newManifest, "auth-old-0001"), // same id as the superseded run
          reason: "test",
          registry
        }),
      (error: unknown) => error instanceof GraphRevisionError && error.code === "AUTHORIZATION_NOT_REBOUND"
    );
  });

  it("rejects an authorization bound to a different manifest than the one being revised to", () => {
    const oldManifest = manifestWith({ runId: "run-old-0001", graphVersion: 1 });
    const newManifest = manifestWith({ runId: "run-new-0001", graphVersion: 2 });
    const someOtherManifest = manifestWith({ runId: "run-new-0001", graphVersion: 2, goal: "different goal text" });
    const oldFrozen = freezeManifest(oldManifest, registry);

    assert.throws(
      () =>
        createGraphRevision({
          supersededRun: {
            runId: "run-old-0001",
            graphVersion: 1,
            manifestSha256: oldFrozen.sha256,
            authorizationId: "auth-old-0001",
            manifest: oldManifest
          },
          newManifest,
          newAuthorization: authorizationFor(someOtherManifest, "auth-new-0001"),
          reason: "test",
          registry
        }),
      (error: unknown) => error instanceof GraphRevisionError && error.code === "AUTHORIZATION_NOT_REBOUND"
    );
  });
});
