import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { test } from "node:test";

test("stable release isolation gate refuses an unproven host backend", () => {
  let output = "";
  try {
    output = execFileSync(process.execPath, [resolve("scripts/isolation-preflight.mjs")], {
      cwd: process.cwd(),
      encoding: "utf8"
    });
    assert.fail("isolation preflight unexpectedly passed without an OS-isolated backend");
  } catch (error) {
    const child = error as { status?: number; stdout?: string };
    output = child.stdout ?? output;
    assert.equal(child.status, 2);
  }

  const report = JSON.parse(output) as { status: string; code: string; checks: Array<{ id: string; status: string }> };
  assert.equal(report.status, "BLOCKED");
  assert.equal(report.code, "ISOLATION_BACKEND_UNPROVEN");
  assert.equal(report.checks.find((check) => check.id === "os-isolated-boundary")?.status, "BLOCKED");
});
