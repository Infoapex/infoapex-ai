import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { test } from "node:test";

test("P6 RC audit passes local checks but remains inconclusive without external evidence", () => {
  const output = execFileSync(process.execPath, [resolve("scripts/rc-audit.mjs")], { cwd: process.cwd(), encoding: "utf8" });
  const report = JSON.parse(output) as { status: string; code: string; releaseAction: string; missingExternalEvidence: string[]; localChecks: { status: string }[] };
  assert.equal(report.status, "INCONCLUSIVE");
  assert.equal(report.code, "RC_LOCAL_AUDIT_PASS_EXTERNAL_EVIDENCE_MISSING");
  assert.equal(report.releaseAction, "NO_PUBLICATION");
  assert.ok(report.missingExternalEvidence.includes("consumer-pilot"));
  assert.ok(report.localChecks.every((check) => check.status === "PASS"));
});
