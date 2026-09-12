import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";

const cli = resolve("dist/src/cli.js");

test("production health and invalid production commands retain JSON status/error contracts", () => {
  const repo = mkdtempSync(join(tmpdir(), "infoapex-operability-cli-"));
  try {
    let failure: { status?: number; stdout?: string; stderr?: string } | undefined;
    try { execFileSync(process.execPath, [cli, "production", "health", "--repo", repo], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }); } catch (error) { failure = error as { status?: number; stdout?: string; stderr?: string }; }
    if (failure === undefined) assert.fail("expected blocked health result");
    const health = JSON.parse(failure.stdout ?? "") as { schemaVersion: string; status: string; components: { root: { code: string } } };
    assert.equal(health.schemaVersion, "1.0"); assert.equal(health.status, "BLOCKED"); assert.equal(health.components.root.code, "POLICY_INVALID");
    try { execFileSync(process.execPath, [cli, "production", "unknown", "--repo", repo], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }); assert.fail("expected usage failure"); } catch (error) {
      const result = error as { stderr?: string }; const body = JSON.parse(result.stderr ?? "") as { status: string; error: string };
      assert.equal(body.status, "BLOCKED"); assert.match(body.error, /production <doctor\|health\|lease\|retention>/);
    }
  } finally { rmSync(repo, { recursive: true, force: true }); }
});
