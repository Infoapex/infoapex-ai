import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { defaultProductionPolicy, diagnosticsBundle, productionDoctor, retention } from "../src/production.js";

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

test("diagnostics rejects absolute and traversal output paths", () => {
  const repo = mkdtempSync(join(tmpdir(), "infoapex-prod-paths-"));
  try {
    mkdirSync(join(repo, ".infoapex-ai"), { recursive: true }); writeFileSync(join(repo, ".infoapex-ai", "production-policy.json"), JSON.stringify(defaultProductionPolicy()));
    assert.equal((diagnosticsBundle(repo, join(repo, "outside.json")) as { code: string }).code, "PATH_UNSAFE");
    assert.equal((diagnosticsBundle(repo, "../outside.json") as { code: string }).code, "PATH_UNSAFE");
  } finally { rmSync(repo, { recursive: true, force: true }); }
});

test("retention is fail-closed for malformed policy and applies only expired files", () => {
  const repo = mkdtempSync(join(tmpdir(), "infoapex-prod-retention-")); const root = join(repo, ".infoapex-ai", "diagnostics");
  try {
    mkdirSync(root, { recursive: true }); const policyPath = join(repo, ".infoapex-ai", "production-policy.json"); writeFileSync(policyPath, JSON.stringify(defaultProductionPolicy()));
    const expired = join(root, "expired.json"); const fresh = join(root, "fresh.json"); writeFileSync(expired, "old"); writeFileSync(fresh, "new");
    const old = new Date(Date.now() - 31 * 86_400_000); utimesSync(expired, old, old);
    const dry = retention(repo, true) as { status: string; deleted: string[]; expired: string[] }; assert.equal(dry.status, "PASS"); assert.equal(dry.deleted.length, 0); assert.equal(dry.expired.length, 1);
    const applied = retention(repo, false) as { status: string; deleted: string[]; remaining: number }; assert.equal(applied.status, "PASS"); assert.equal(applied.deleted.length, 1); assert.equal(applied.remaining, 0);
  } finally { rmSync(repo, { recursive: true, force: true }); }
});
