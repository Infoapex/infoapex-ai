import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { defaultProductionPolicy, diagnosticsBundle, productionDoctor } from "../src/production.js";

test("production defaults disable external actions, export and raw conversations", () => {
  const policy = defaultProductionPolicy();
  assert.equal(policy.externalActions, "disabled"); assert.equal(policy.telemetryExport, "off"); assert.equal(policy.rawConversationStorage, false); assert.equal(policy.resources.maximumParallelWriters, 1);
});

test("production doctor fails closed without policy", () => {
  const repo = mkdtempSync(join(tmpdir(), "infoapex-prod-missing-"));
  try { assert.equal(productionDoctor(repo).status, "BLOCKED"); } finally { rmSync(repo, { recursive: true, force: true }); }
});

test("diagnostics never contains configuration values or environment variables", () => {
  const repo = mkdtempSync(join(tmpdir(), "infoapex-prod-diagnostics-"));
  try {
    // A deliberately sensitive sentinel in an unmanaged file must never be collected.
    mkdirSync(join(repo, ".infoapex-ai"), { recursive: true }); writeFileSync(join(repo, ".infoapex-ai", "production-policy.json"), JSON.stringify(defaultProductionPolicy()));
    writeFileSync(join(repo, "secret.txt"), "P6_SENTINEL_SECRET");
    const result = diagnosticsBundle(repo, ".infoapex-ai/diagnostics/test.json") as { status: string; output: string };
    assert.equal(result.status, "PASS"); assert.doesNotMatch(readFileSync(result.output, "utf8"), /P6_SENTINEL_SECRET/);
  } finally { rmSync(repo, { recursive: true, force: true }); }
});
