import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { describe, it } from "node:test";

describe("P2-A bounded provider preflight", () => {
  it("freezes two tasks, keeps GRAPH-06 disabled, and reports normalized fixture usage", () => {
    const result = spawnSync(process.execPath, ["scripts/p2-live-preflight.mjs", "--fixture", "--json"], {
      cwd: process.cwd(),
      encoding: "utf8",
      timeout: 120_000,
      windowsHide: true
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const report = JSON.parse(result.stdout);

    assert.equal(report.functionalVerdict, "PASS");
    assert.equal(report.frozen.graph06Enabled, false);
    assert.equal(report.frozen.maximumLiveInvocations, 2);
    assert.equal(report.smokes.length, 2);
    assert.deepEqual(report.smokes.map((smoke: { status: string }) => smoke.status), ["DONE", "DONE"]);
    assert.deepEqual(report.classification.map((entry: { actual: boolean }) => entry.actual), [true, true, false]);
    assert.equal(report.economicVerdict, "inconclusive");
    assert.equal(report.p2bReadiness, "FUNCTIONAL_READY_ECONOMIC_PARTIAL");
  });
});
