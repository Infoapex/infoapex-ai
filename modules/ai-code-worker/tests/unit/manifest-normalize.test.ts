import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { freezeManifest } from "../../src/manifest/normalize.js";
import { SchemaRegistry, SchemaValidationError } from "../../src/schema/json-schema.js";

const registry = SchemaRegistry.load({ schemaDirectory: "schemas" });

describe("manifest freeze", () => {
  it("validates and hashes a minimal accepted manifest", () => {
    const manifest = readFixture("valid-minimal.json");
    const frozen = freezeManifest(manifest, registry);

    assert.match(frozen.sha256, /^[a-f0-9]{64}$/);
    assert.equal(JSON.parse(frozen.normalized).runId, "run_phase0_001");
  });

  it("hashes the same semantic manifest identically regardless of object key order", () => {
    const manifest = readFixture("valid-minimal.json") as Record<string, unknown>;
    const reordered = {
      budgets: manifest.budgets,
      globalGates: manifest.globalGates,
      tasks: manifest.tasks,
      goal: manifest.goal,
      base: manifest.base,
      plan: manifest.plan,
      graphVersion: manifest.graphVersion,
      runId: manifest.runId,
      schemaVersion: manifest.schemaVersion
    };

    assert.equal(freezeManifest(reordered, registry).sha256, freezeManifest(manifest, registry).sha256);
  });

  it("rejects manifests compiled from proposed plans", () => {
    assert.throws(
      () => freezeManifest(readFixture("invalid-proposed-plan.json"), registry),
      (error) => error instanceof SchemaValidationError && error.issues.some((issue) => issue.instancePath === "/plan/status")
    );
  });
});

function readFixture(name: string): unknown {
  return JSON.parse(readFileSync(join("tests", "fixtures", "manifest", name), "utf8"));
}
