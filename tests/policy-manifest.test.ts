import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";

test("policy manifest hashes the exact committed policy blobs", () => {
  const outputRoot = mkdtempSync(join(tmpdir(), "infoapex-policy-manifest-"));
  const output = join(outputRoot, "policy.json");
  try {
    execFileSync(process.execPath, ["scripts/generate-policy-manifest.mjs", "--out", output], { cwd: process.cwd(), stdio: "ignore" });
    assert.equal(existsSync(output), true);
    const manifest = JSON.parse(readFileSync(output, "utf8")) as { kind: string; commit: string; files: readonly { path: string; sha256: string }[] };
    assert.equal(manifest.kind, "infoapex-ai-policy-manifest");
    assert.match(manifest.commit, /^[0-9a-f]{40}$/);
    assert.ok(manifest.files.length >= 8);
    for (const entry of manifest.files) assert.match(entry.sha256, /^[0-9a-f]{64}$/);
  } finally {
    rmSync(outputRoot, { recursive: true, force: true });
  }
});
