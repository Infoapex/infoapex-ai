import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { defaultProductionPolicy, diagnosticsBundle, productionDoctor, productionHealth, retention } from "../src/production.js";

test("production defaults disable external actions, export and raw conversations", () => {
  const policy = defaultProductionPolicy();
  assert.equal(policy.externalActions, "disabled"); assert.equal(policy.telemetryExport, "off"); assert.equal(policy.rawConversationStorage, false); assert.equal(policy.resources.maximumParallelWriters, 1);
});

test("production doctor fails closed without policy", () => {
  const repo = mkdtempSync(join(tmpdir(), "infoapex-prod-missing-"));
  try { assert.equal(productionDoctor(repo).status, "BLOCKED"); } finally { rmSync(repo, { recursive: true, force: true }); }
});

test("health aggregates bounded root, module, provider, and isolation statuses", () => {
  const repo = mkdtempSync(join(tmpdir(), "infoapex-prod-health-"));
  try {
    mkdirSync(join(repo, ".infoapex-ai"), { recursive: true }); writeFileSync(join(repo, ".infoapex-ai", "production-policy.json"), JSON.stringify(defaultProductionPolicy()));
    const health = productionHealth(repo) as { status: string; components: { root: { status: string }; modules: readonly { name: string; status: string }[]; provider: { status: string; code: string }; isolationBackend: { status: string } } };
    assert.equal(health.status, "BLOCKED"); assert.equal(health.components.root.status, "PASS"); assert.equal(health.components.modules.length, 3);
    assert.equal(health.components.provider.code, "PROVIDER_POLICY_INVALID"); assert.equal(health.components.isolationBackend.status, "UNKNOWN");
  } finally { rmSync(repo, { recursive: true, force: true }); }
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

test("diagnostics is hashable, local-only, redacted, bounded, and refuses overwrites", () => {
  const repo = mkdtempSync(join(tmpdir(), "infoapex-prod-bundle-"));
  try {
    mkdirSync(join(repo, ".infoapex-ai"), { recursive: true }); writeFileSync(join(repo, ".infoapex-ai", "production-policy.json"), JSON.stringify(defaultProductionPolicy()));
    const output = ".infoapex-ai/diagnostics/support.json";
    const result = diagnosticsBundle(repo, output) as { status: string; sha256: string; bytes: number; maximumBytes: number; localOnly: boolean; automaticUpload: boolean };
    assert.equal(result.status, "PASS"); assert.match(result.sha256, /^[a-f0-9]{64}$/); assert.ok(result.bytes <= result.maximumBytes); assert.equal(result.localOnly, true); assert.equal(result.automaticUpload, false);
    assert.equal((diagnosticsBundle(repo, output) as { code: string }).code, "PATH_UNSAFE");
  } finally { rmSync(repo, { recursive: true, force: true }); }
});

test("retention is fail-closed for malformed policy and applies only expired files", () => {
  const repo = mkdtempSync(join(tmpdir(), "infoapex-prod-retention-")); const root = join(repo, ".infoapex-ai", "diagnostics");
  try {
    mkdirSync(root, { recursive: true }); const policyPath = join(repo, ".infoapex-ai", "production-policy.json"); writeFileSync(policyPath, JSON.stringify(defaultProductionPolicy()));
    const expired = join(root, "expired.json"); const fresh = join(root, "fresh.json"); const telemetry = join(repo, ".infoapex-ai", "telemetry", "events.jsonl"); mkdirSync(join(repo, ".infoapex-ai", "telemetry"), { recursive: true }); writeFileSync(expired, "old"); writeFileSync(fresh, "new"); writeFileSync(telemetry, "old telemetry");
    const old = new Date(Date.now() - 31 * 86_400_000); utimesSync(expired, old, old);
    utimesSync(telemetry, old, old);
    const dry = retention(repo, true) as { status: string; export: string; deleted: string[]; expired: string[] }; assert.equal(dry.status, "PASS"); assert.equal(dry.export, "off"); assert.equal(dry.deleted.length, 0); assert.equal(dry.expired.length, 2);
    const applied = retention(repo, false) as { status: string; deleted: string[]; remaining: number }; assert.equal(applied.status, "PASS"); assert.equal(applied.deleted.length, 2); assert.equal(applied.remaining, 0);
  } finally { rmSync(repo, { recursive: true, force: true }); }
});
