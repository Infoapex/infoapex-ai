import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

function run(root: string) {
  return spawnSync(process.execPath, ["scripts/check-generic-boundary.mjs"], {
    cwd: process.cwd(),
    encoding: "utf8",
    timeout: 30_000,
    windowsHide: true,
    env: { ...process.env, APEX_GENERIC_BOUNDARY_ROOT: root }
  });
}

describe("generic boundary check", () => {
  it("ignores a base64 data-URI payload that coincidentally contains the forbidden term", () => {
    // tests/fixtures/generic-boundary/clean/inline-image.svg embeds a base64
    // PNG payload whose bytes happen to decode to a substring matching the
    // forbidden term case-insensitively -- the exact way the real splash SVG
    // tripped this check (a random base64 run reading as a product reference).
    const result = run(join(process.cwd(), "tests/fixtures/generic-boundary/clean"));
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /passed/i);
  });

  it("still fails on the forbidden term when it sits in plain text, not a data URI", () => {
    // Generated at test time, outside the repository, so the offending text
    // is never checked in -- the real, unscoped `check:generic-boundary` run
    // scans the whole repo and would otherwise flag a permanent fixture.
    const dir = mkdtempSync(join(tmpdir(), "apex-boundary-"));
    try {
      const term = String.fromCharCode(112, 97, 99, 111, 109, 97, 114, 107, 101, 116);
      writeFileSync(join(dir, "leak.md"), `See the ${term} integration notes.\n`, "utf8");
      const result = run(dir);
      assert.equal(result.status, 1, result.stdout);
      assert.match(result.stderr, /forbidden product-specific reference/i);
      assert.match(result.stderr, /leak\.md/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
