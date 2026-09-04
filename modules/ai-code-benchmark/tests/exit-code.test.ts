import assert from "node:assert/strict";
import test from "node:test";
import { benchmarkReportExitCode } from "../src/exit-code.js";

test("report exit codes preserve reject, inconclusive, and security boundaries", () => {
  assert.equal(benchmarkReportExitCode({ verdict: "ACCEPT", limitations: [] }), 0);
  assert.equal(benchmarkReportExitCode({ verdict: "ACCEPT_WITH_LIMITS", limitations: [] }), 0);
  assert.equal(benchmarkReportExitCode({ verdict: "REJECT", limitations: [] }), 4);
  assert.equal(benchmarkReportExitCode({ verdict: "INCONCLUSIVE", limitations: [] }), 5);
  assert.equal(benchmarkReportExitCode({ verdict: "REJECT", limitations: ["CRITICAL_SAFETY_FAILURE"] }), 6);
});
