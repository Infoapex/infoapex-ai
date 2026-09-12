import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";

test("P6 DX quickstart runs a bounded fake consumer flow in isolation", () => {
  const output = execFileSync(process.execPath, [resolve("scripts/dx-quickstart-check.mjs")], { cwd: process.cwd(), encoding: "utf8" });
  const result = JSON.parse(output) as { status: string; code: string; provider: string };
  assert.deepEqual(result, { ...result, status: "PASS", code: "DX_QUICKSTART_PASS", provider: "fake" });
});

test("P6 pilot preregistration does not fabricate live evidence", () => {
  const pilot = JSON.parse(readFileSync(resolve("validation/p6/pilot-preregistration.json"), "utf8")) as { status: string; verdict: unknown; evidence: unknown[]; scope: { consumerRepositories: number; boundedTasks: number } };
  assert.equal(pilot.status, "NOT_STARTED");
  assert.equal(pilot.verdict, null);
  assert.equal(pilot.evidence.length, 0);
  assert.equal(pilot.scope.consumerRepositories, 3);
  assert.equal(pilot.scope.boundedTasks, 60);
});
