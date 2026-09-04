import assert from "node:assert/strict";
import test from "node:test";
import { canonicalJson } from "../src/canonical-json.js";
import { buildBenchmarkReport, pairObservations, renderMarkdownReport } from "../src/report.js";

const hash = "a".repeat(64);
function observation(id: string, armId: string, taskId = "task-one", extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { id, armId, taskId, repetition: 1, provider: "fake", environmentId: "env-one", experimentHash: hash, status: "DONE", evaluation: { verdict: "PASS", scope: { verdict: "PASS" }, criticalSafetyFailure: false }, metrics: { latency: { totalLatencyMs: armId === "candidate" ? 8 : 10, providerLatencyMs: 5, harnessLatencyMs: 5 }, usage: { inputUncachedTokens: 10, outputTokens: 2, costUsd: armId === "candidate" ? 0.5 : 1 } }, ...extra };
}

function hypothesis(value: { improves: string[]; nonRegression: string[]; thresholds: Record<string, number> }): Record<string, unknown> {
  return { schemaVersion: "1.0", id: "candidate-test", candidateChange: "one bounded change", suiteId: "suite-test", maximumCostUsd: null, possibleVerdicts: ["ACCEPT", "REJECT", "INCONCLUSIVE", "ACCEPT_WITH_LIMITS"], ...value };
}

test("paired reports are independent of input order and expose distributions/counts", () => {
  const rows = [observation("b", "candidate"), observation("a", "baseline")];
  const options = { experimentHash: hash, baselineArmId: "baseline", candidateArmId: "candidate", expectedObservationCount: 2, candidateHypothesis: hypothesis({ improves: ["verified-task-success"], nonRegression: ["costUsd"], thresholds: { "verified-task-success": 0, costUsd: 1 } }), generatedAt: "2026-01-01T00:00:00.000Z" };
  const one = buildBenchmarkReport(rows, options); const two = buildBenchmarkReport([...rows].reverse(), options);
  assert.equal(canonicalJson(one), canonicalJson(two)); assert.equal(one.verdict, "ACCEPT"); assert.equal(one.comparison?.pairedCount, 1);
  assert.equal(one.aggregates["baseline.success"]?.sampleCount, 1); assert.equal(one.aggregates["baseline.success"]?.completeness, 1); assert.equal(one.aggregates["delta.candidate.vs.baseline.costUsd"]?.value, -0.5);
});

test("pairing requires task, repetition, provider, and environment", () => {
  const left = observation("a", "baseline"); const right = observation("b", "candidate", "task-one", { provider: "another" });
  assert.equal(pairObservations([left, right], "baseline", "candidate").pairs.length, 0);
  assert.equal(pairObservations([left, { ...right, provider: "fake", environmentId: "other" }], "baseline", "candidate").pairs.length, 0);
});

test("null primary values, protocol mismatch, and fewer than 90% valid are inconclusive", () => {
  const rows = [observation("a", "baseline", "task-one", { valid: false, protocolHash: "one" }), observation("b", "candidate", "task-one", { protocolHash: "two", metrics: null })];
  const report = buildBenchmarkReport(rows, { experimentHash: hash, baselineArmId: "baseline", candidateArmId: "candidate", expectedObservationCount: 4, candidateHypothesis: hypothesis({ improves: ["totalLatencyMs"], nonRegression: ["costUsd"], thresholds: { totalLatencyMs: 0, costUsd: 0 } }) });
  assert.equal(report.verdict, "INCONCLUSIVE"); assert.ok(report.limitations.includes("PROTOCOL_HASH_MISMATCH")); assert.ok(report.limitations.includes("FEWER_THAN_90_PERCENT_VALID"));
});

test("critical safety failure overrides an otherwise acceptable candidate", () => {
  const report = buildBenchmarkReport([observation("a", "baseline"), observation("b", "candidate", "task-one", { criticalSafetyFailure: true })], { experimentHash: hash, baselineArmId: "baseline", candidateArmId: "candidate", expectedObservationCount: 2, candidateHypothesis: hypothesis({ improves: ["success"], nonRegression: ["costUsd"], thresholds: { success: 0, costUsd: 1 } }) });
  assert.equal(report.verdict, "REJECT");
});

test("an unevaluated DONE claim is not counted as verified success or a valid observation", () => {
  const row = { ...observation("a", "baseline"), evaluation: null };
  const report = buildBenchmarkReport([row], { experimentHash: hash, expectedObservationCount: 1 });
  assert.equal(report.aggregates["baseline.success"]?.value, null);
  assert.equal(report.counts?.valid, 0);
  assert.ok(report.limitations.includes("FEWER_THAN_90_PERCENT_VALID"));
});

test("a frozen expected protocol or experiment hash mismatch is inconclusive", () => {
  const rows = [observation("a", "baseline", "task-one", { protocolHash: "wrong" }), observation("b", "candidate", "task-one", { protocolHash: "wrong" })];
  const report = buildBenchmarkReport(rows, { experimentHash: hash, protocolHash: "expected", baselineArmId: "baseline", candidateArmId: "candidate", expectedObservationCount: 2, candidateHypothesis: hypothesis({ improves: ["success"], nonRegression: ["costUsd"], thresholds: { success: 0, costUsd: 1 } }) });
  assert.equal(report.verdict, "INCONCLUSIVE");
  assert.ok(report.limitations.includes("PROTOCOL_HASH_MISMATCH"));
});

test("a bounded canary is inconclusive for sample coverage without inventing protocol drift", () => {
  const rows = [observation("a", "baseline"), observation("b", "candidate")];
  const report = buildBenchmarkReport(rows, { experimentHash: hash, protocolHash: null, baselineArmId: "baseline", candidateArmId: "candidate", expectedObservationCount: 20, candidateHypothesis: hypothesis({ improves: ["success"], nonRegression: ["costUsd"], thresholds: { success: 0, costUsd: 1 } }) });
  assert.equal(report.verdict, "INCONCLUSIVE"); assert.ok(report.limitations.includes("FEWER_THAN_90_PERCENT_VALID")); assert.equal(report.limitations.includes("PROTOCOL_HASH_MISMATCH"), false);
});

test("missing every declared improvement threshold rejects instead of accepting with limits", () => {
  const rows = [observation("a", "baseline"), observation("b", "candidate", "task-one", { evaluation: { verdict: "FAIL", scope: { verdict: "PASS" }, criticalSafetyFailure: false } })];
  const report = buildBenchmarkReport(rows, { experimentHash: hash, baselineArmId: "baseline", candidateArmId: "candidate", expectedObservationCount: 2, candidateHypothesis: hypothesis({ improves: ["success"], nonRegression: ["costUsd"], thresholds: { success: 0, costUsd: 1 } }) });
  assert.equal(report.verdict, "REJECT");
});

test("the frozen OpenTelemetry metrics accept coverage only when safety and overhead do not regress", () => {
  const baseline = observation("a", "baseline", "task-one", { verifiedTaskSuccess: 1, eligibleTraceCoverage: 0, telemetryLeakageCount: 0, harnessOverheadPercent: 0 });
  const candidate = observation("b", "candidate", "task-one", { verifiedTaskSuccess: 1, eligibleTraceCoverage: 1, telemetryLeakageCount: 0, harnessOverheadPercent: 2 });
  const frozen = hypothesis({ improves: ["eligibleTraceCoverage"], nonRegression: ["verifiedTaskSuccess", "harnessOverheadPercent", "telemetryLeakageCount"], thresholds: { eligibleTraceCoverage: 0.95, verifiedTaskSuccess: 0, harnessOverheadPercent: 5, telemetryLeakageCount: 0 } });
  const report = buildBenchmarkReport([baseline, candidate], { experimentHash: hash, baselineArmId: "baseline", candidateArmId: "candidate", expectedObservationCount: 2, candidateHypothesis: frozen });
  assert.equal(report.verdict, "ACCEPT");
  assert.deepEqual(report.verdicts, { eligibleTraceCoverage: "PASS", verifiedTaskSuccess: "PASS", harnessOverheadPercent: "PASS", telemetryLeakageCount: "PASS" });

  const excessive = buildBenchmarkReport([baseline, { ...candidate, harnessOverheadPercent: 6 }], { experimentHash: hash, baselineArmId: "baseline", candidateArmId: "candidate", expectedObservationCount: 2, candidateHypothesis: frozen });
  assert.equal(excessive.verdict, "REJECT");
  assert.equal(excessive.verdicts?.harnessOverheadPercent, "FAIL");
});

test("Markdown report escapes table delimiters and newlines", () => {
  const report = buildBenchmarkReport([observation("a", "baseline")], { experimentHash: hash, generatedAt: "2026-01-01T00:00:00.000Z" });
  const markdown = renderMarkdownReport(report); assert.match(markdown, /\| Metric \| Value/); assert.doesNotMatch(markdown, /undefined/); assert.match(markdown, /FEWER_THAN_90_PERCENT_VALID|NO_CANDIDATE_HYPOTHESIS/);
});
