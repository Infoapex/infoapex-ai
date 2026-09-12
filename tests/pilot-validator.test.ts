import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import test from "node:test";

test("P6 pilot validator preserves the preregistration boundary", () => {
  let exitCode = 0;
  let output = "";
  try {
    output = execFileSync(process.execPath, ["scripts/validate-p6-pilot.mjs"], { encoding: "utf8" });
  } catch (error) {
    exitCode = (error as { status?: number }).status ?? -1;
    output = (error as { stdout?: string }).stdout ?? "";
  }
  const report = JSON.parse(output) as { status: string; code: string };
  assert.equal(exitCode, 2);
  assert.deepEqual({ status: report.status, code: report.code }, { status: "NOT_STARTED", code: "PILOT_NOT_STARTED" });
});

test("P6 pilot validator never accepts an incomplete PASS manifest", () => {
  const manifest = {
    schemaVersion: "1.0",
    pilotId: "p6-consumer-adoption-v1",
    status: "PASS",
    verdict: "PASS",
    repositories: [],
    observations: [],
    checkpoints: { firstAt: "2026-09-12T00:00:00Z", lastAt: "2026-09-12T00:00:00Z" },
    scenarios: { upgrade: false, rollback: false, incidentDrill: false, restore: false },
    quickstartUnaidedPercent: 0,
    privacy: { rawConversations: false, providerOutput: false, secrets: false, automaticUpload: false, sanitized: true },
    stopConditions: []
  };
  let output = "";
  try {
    output = execFileSync(process.execPath, ["scripts/validate-p6-pilot.mjs", "--manifest", "-"], { input: JSON.stringify(manifest), encoding: "utf8" });
  } catch (error) {
    output = (error as { stdout?: string }).stdout ?? "";
  }
  assert.match(output, /PILOT_PASS_UNPROVEN|PILOT_EVIDENCE_INVALID/);
});
