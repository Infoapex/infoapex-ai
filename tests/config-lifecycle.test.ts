import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { migrate, rollbackConfig, validateConfig } from "../src/config-lifecycle.js";

const managed = [".infoapex-ai/config.json", ".infoapex-ai/install-profile.json", ".infoapex-ai/production-policy.json", ".ai-code-worker/config.json", ".ai-code-worker/routing-policy.json", ".ai-code-review/config.json", ".ai-code-docs/config.json", ".ai-code-control/config/code-control.json", ".ai-code-control/config/memory-control.json"];

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), "infoapex-migrate-"));
  for (const path of managed) {
    mkdirSync(join(root, path, ".."), { recursive: true });
    const profile = path.endsWith("install-profile.json");
    writeFileSync(join(root, path), JSON.stringify(profile ? { schemaVersion: "1.0", profile: "generic", bundleRoot: root } : path.includes("ai-code-control/config") ? {} : { schemaVersion: "1.0" }));
  }
  return root;
}

function journalPath(root: string): string { return join(root, ".infoapex-ai", "migrations", "config-v1.json"); }

test("future config versions fail closed before migration", () => {
  const root = fixture();
  try {
    writeFileSync(join(root, ".ai-code-worker/config.json"), JSON.stringify({ schemaVersion: "2.0" }));
    assert.equal(validateConfig(root).status, "BLOCKED");
    const result = migrate(root, "apply") as { status: string; code: string };
    assert.deepEqual({ status: result.status, code: result.code }, { status: "BLOCKED", code: "CONFIG_INVALID" });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("check and dry-run are stable, and apply is idempotent", () => {
  const root = fixture();
  try {
    for (const mode of ["check", "dry-run"] as const) {
      const result = migrate(root, mode) as { status: string; code: string; mode: string };
      assert.deepEqual({ status: result.status, code: result.code, mode: result.mode }, { status: "PASS", code: "MIGRATION_READY", mode });
    }
    const first = migrate(root, "apply") as { status: string; code: string };
    assert.deepEqual({ status: first.status, code: first.code }, { status: "PASS", code: "MIGRATION_APPLIED" });
    const repeated = migrate(root, "apply") as { status: string; code: string; idempotent: boolean };
    assert.deepEqual({ status: repeated.status, code: repeated.code, idempotent: repeated.idempotent }, { status: "PASS", code: "MIGRATION_ALREADY_APPLIED", idempotent: true });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("rollback verifies backups and refuses to overwrite a changed target", () => {
  const root = fixture();
  try {
    assert.equal((migrate(root, "apply") as { status: string }).status, "PASS");
    const dryRun = rollbackConfig(root, "config-v1", true) as { status: string; code: string };
    assert.deepEqual(dryRun, { schemaVersion: "1.0", status: "PASS", code: "ROLLBACK_READY", migrationId: "config-v1", mode: "dry-run", files: managed });
    const restored = rollbackConfig(root) as { status: string; code: string; restored: number };
    assert.deepEqual({ status: restored.status, code: restored.code, restored: restored.restored }, { status: "PASS", code: "ROLLBACK_APPLIED", restored: managed.length });

    writeFileSync(join(root, ".ai-code-worker/config.json"), JSON.stringify({ schemaVersion: "1.0", changed: true }));
    const blocked = rollbackConfig(root) as { status: string; code: string; message: string };
    assert.deepEqual({ status: blocked.status, code: blocked.code }, { status: "BLOCKED", code: "TARGET_CHANGED" });
    assert.match(blocked.message, /Target changed/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("malformed or path-escaping journals fail closed before backup access", () => {
  const root = fixture();
  try {
    assert.equal((migrate(root, "apply") as { status: string }).status, "PASS");
    const journal = JSON.parse(readFileSync(journalPath(root), "utf8")) as Record<string, unknown>;
    const backupRoot = journal.backupRoot as string;
    writeFileSync(join(root, backupRoot, ".ai-code-worker", "config.json"), "tampered");
    const tampered = rollbackConfig(root) as { status: string; code: string };
    assert.deepEqual({ status: tampered.status, code: tampered.code }, { status: "BLOCKED", code: "BACKUP_VERIFICATION_FAILED" });

    journal.backupRoot = "../outside";
    writeFileSync(journalPath(root), JSON.stringify(journal));
    const escaped = rollbackConfig(root) as { status: string; code: string };
    assert.deepEqual({ status: escaped.status, code: escaped.code }, { status: "BLOCKED", code: "JOURNAL_INVALID" });

    writeFileSync(journalPath(root), "{");
    const malformed = migrate(root, "apply") as { status: string; code: string };
    assert.deepEqual({ status: malformed.status, code: malformed.code }, { status: "BLOCKED", code: "JOURNAL_INVALID" });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("unsafe migration identifiers are rejected without resolving a journal path", () => {
  const root = fixture();
  try {
    const result = rollbackConfig(root, "../outside") as { status: string; code: string };
    assert.deepEqual({ status: result.status, code: result.code }, { status: "BLOCKED", code: "MIGRATION_ID_UNSUPPORTED" });
  } finally { rmSync(root, { recursive: true, force: true }); }
});
