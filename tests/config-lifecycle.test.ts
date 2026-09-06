import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { migrate, rollbackConfig, validateConfig } from "../src/config-lifecycle.js";

const managed = [".infoapex-ai/config.json", ".infoapex-ai/install-profile.json", ".infoapex-ai/production-policy.json", ".ai-code-worker/config.json", ".ai-code-worker/routing-policy.json", ".ai-code-review/config.json", ".ai-code-docs/config.json", ".ai-code-control/config/code-control.json", ".ai-code-control/config/memory-control.json"];
function fixture(): string { const root = mkdtempSync(join(tmpdir(), "infoapex-migrate-")); for (const path of managed) { mkdirSync(join(root, path, ".."), { recursive: true }); const profile = path.endsWith("install-profile.json"); writeFileSync(join(root, path), JSON.stringify(profile ? { schemaVersion: "1.0", profile: "generic", bundleRoot: root } : path.includes("ai-code-control/config") ? {} : { schemaVersion: "1.0" })); } return root; }

test("future config versions fail before migration", () => { const root = fixture(); try { writeFileSync(join(root, ".ai-code-worker/config.json"), JSON.stringify({ schemaVersion: "2.0" })); assert.equal(validateConfig(root).status, "BLOCKED"); assert.equal(migrate(root, "apply").status, "BLOCKED"); } finally { rmSync(root, { recursive: true, force: true }); } });
test("migration is idempotent and rollback verifies backup", () => { const root = fixture(); try { const first = migrate(root, "apply") as { status: string }; assert.equal(first.status, "PASS"); assert.equal((migrate(root, "apply") as { idempotent: boolean }).idempotent, true); writeFileSync(join(root, ".ai-code-worker/config.json"), JSON.stringify({ schemaVersion: "1.0", changed: true })); assert.equal((rollbackConfig(root) as { status: string }).status, "PASS"); assert.deepEqual(JSON.parse(readFileSync(join(root, ".ai-code-worker/config.json"), "utf8")), { schemaVersion: "1.0" }); } finally { rmSync(root, { recursive: true, force: true }); } });
