import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

const checker = "scripts/compatibility-check.mjs";

function run(...args: string[]): { status: number | null; report: Record<string, unknown> } {
  const result = spawnSync(process.execPath, [checker, ...args], { cwd: process.cwd(), encoding: "utf8", windowsHide: true });
  assert.notEqual(result.stdout.trim(), "", result.stderr);
  return { status: result.status, report: JSON.parse(result.stdout) as Record<string, unknown> };
}

test("compatibility contract accepts every declared platform/runtime/provider boundary", () => {
  for (const platform of ["win32", "linux", "darwin"]) {
    for (const runtime of ["22.0.0", "24.0.0"]) {
      const result = run("--platform", platform, "--runtime", runtime, "--provider", "fake", "--provider-version", "1.0.0", "--require-provider-capability");
      assert.equal(result.status, 0, JSON.stringify(result.report));
      assert.equal(result.report.status, "PASS");
      assert.deepEqual(result.report.diagnostics, [{ code: "PROVIDER_CAPABILITY_AVAILABLE", severity: "info", expected: "fake:local-process", actual: "available" }]);
    }
  }
});

test("unsupported runtime and provider fail closed with stable machine-readable diagnostics", () => {
  const result = run("--platform", "linux", "--runtime", "21.9.0", "--provider", "codex", "--provider-version", "999.0.0");
  assert.equal(result.status, 2);
  assert.equal(result.report.status, "BLOCKED");
  assert.equal(result.report.code, "COMPATIBILITY_UNSUPPORTED");
  assert.deepEqual(result.report.diagnostics, [
    { code: "UNSUPPORTED_NODE_RUNTIME", severity: "blocker", expected: "22,24", actual: "21.9.0" },
    { code: "UNSUPPORTED_PROVIDER", severity: "blocker", expected: "fake", actual: "codex" }
  ]);
});

test("provider version drift fails before a provider capability probe", () => {
  const result = run("--platform", "darwin", "--runtime", "24.1.0", "--provider", "fake", "--provider-version", "1.0.1", "--require-provider-capability");
  assert.equal(result.status, 2);
  assert.deepEqual(result.report.diagnostics, [{ code: "UNSUPPORTED_PROVIDER_VERSION", severity: "blocker", expected: "1.0.0", actual: "1.0.1" }]);
});
