import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

function run(script: string): void {
  const result = spawnSync(process.execPath, [script], { cwd: process.cwd(), encoding: "utf8", windowsHide: true });
  assert.equal(result.status, 0, `${script} failed:\n${result.stderr}\n${result.stdout}`);
}

test("npm package content is restricted to supported runtime entries", () => {
  run("scripts/check-npm-package.mjs");
});

test("packed artifact installs and runs from a disposable target", () => {
  run("scripts/package-smoke-test.mjs");
});
