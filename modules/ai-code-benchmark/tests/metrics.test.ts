import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  UsageAccumulator, aggregateCompleteness, appendIntervention, assessEvidence, assessScope,
  captureObservationMetrics, metricCompleteness, parseClaudeUsage, parseCodexUsage, parseInfoapexUsage,
  redactSecrets, splitLatency, importInterventions
} from "../src/metrics.js";

const usage = (input: number, output: number, total = input + output) => ({ inputUncachedTokens: input, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: output, totalTokens: total, costUsd: 0.1 });

test("versioned Codex, Claude, and Infoapex parsers normalize known fields and preserve unknowns", () => {
  const codex = parseCodexUsage(JSON.stringify({ type: "event_msg", payload: { type: "token_count", info: { total_token_usage: { input_tokens: 10, cached_input_tokens: 3, output_tokens: 4, total_tokens: 17 } } } }));
  assert.equal(codex.valid, true); assert.equal(codex.mode, "cumulative"); assert.equal(codex.usage.totalTokens, 17);
  const claude = parseClaudeUsage(JSON.stringify({ result: "ok", usage: { input_tokens: 2, output_tokens: 5 } }));
  assert.equal(claude.usage.inputUncachedTokens, 2); assert.equal(claude.usage.cacheReadTokens, null); assert.equal(claude.usage.totalTokens, null);
  const infoapex = parseInfoapexUsage(JSON.stringify({ schemaVersion: "1.0", status: "DONE", body: { usage: { input_tokens: 4, output_tokens: 1, total_tokens: 5 } } }));
  assert.equal(infoapex.usage.totalTokens, 5);
  assert.equal(parseClaudeUsage("not-json").usage.outputTokens, null);
  assert.equal(parseClaudeUsage(JSON.stringify({ schemaVersion: "9.0", usage: usage(1, 1), result: "x" })).reasons[0], "VERSION_DRIFT");
});

test("cumulative usage is converted to increments and retries/resume do not double count", () => {
  const accumulator = new UsageAccumulator();
  const first = accumulator.add({ provider: "codex", mode: "cumulative", sessionKey: "session-a", sampleId: "run-1", usage: usage(100, 20, 120) });
  const second = accumulator.add({ provider: "codex", mode: "cumulative", sessionKey: "session-a", sampleId: "run-2", usage: usage(130, 30, 160) });
  const retry = accumulator.add({ provider: "codex", mode: "cumulative", sessionKey: "session-a", sampleId: "resume", usage: usage(130, 30, 160) });
  assert.equal(first.usage.totalTokens, 120); assert.equal(second.usage.totalTokens, 40); assert.equal(retry.usage.totalTokens, 0);
  const incremental = new UsageAccumulator();
  assert.equal(incremental.add({ provider: "claude", mode: "incremental", executionKey: "exec", sampleId: "turn-1", usage: usage(3, 4) }).usage.totalTokens, 7);
  assert.equal(incremental.add({ provider: "claude", mode: "incremental", executionKey: "exec", sampleId: "turn-2", usage: usage(3, 4) }).usage.totalTokens, 7);
  assert.equal(incremental.add({ provider: "claude", mode: "incremental", executionKey: "exec", sampleId: "turn-2", usage: usage(3, 4) }).usage.totalTokens, 0);
  assert.equal(accumulator.add({ provider: "codex", mode: "cumulative", usage: usage(2, 1) }).reasons[0], "MISSING_EXECUTION_KEY");
  const firstProcess = new UsageAccumulator();
  firstProcess.add({ provider: "claude", mode: "incremental", sessionKey: "session-resume", executionKey: "execution-one", usage: usage(7, 2) });
  const resumedProcess = new UsageAccumulator(firstProcess.snapshot());
  assert.equal(resumedProcess.add({ provider: "claude", mode: "incremental", sessionKey: "session-resume", executionKey: "execution-one", usage: usage(7, 2) }).duplicate, true);
});

test("latency split keeps provider and harness time distinct", () => {
  assert.deepEqual(splitLatency({ elapsedMs: 500, providerLatencyMs: 350 }), { providerLatencyMs: 350, harnessLatencyMs: 150, totalLatencyMs: 500, reasons: [] });
  const unknown = splitLatency({ elapsedMs: 500 }); assert.equal(unknown.providerLatencyMs, null); assert.equal(unknown.harnessLatencyMs, null);
  assert.equal(splitLatency({ elapsedMs: 100, providerLatencyMs: 200 }).harnessLatencyMs, null);
});

test("diff/scope/evidence data remains explicit when unavailable", () => {
  const scope = assessScope({ changedPaths: ["src/a.ts", "secret.env"], allow: ["src"], deny: ["secret.env"] });
  assert.equal(scope.status, "FAIL"); assert.deepEqual(scope.outOfScopePaths, ["secret.env"]);
  assert.equal(assessScope({ changedPaths: null, allow: ["src"] }).status, "UNKNOWN");
  const evidence = assessEvidence({ expected: 4, present: 3, traceExpected: 2, tracePresent: 2 });
  assert.equal(evidence.coverage, 0.75); assert.equal(evidence.traceCoverage, 1);
  const captured = captureObservationMetrics({ elapsedMs: 20, providerLatencyMs: 10, usage: usage(3, 2), diff: { changedFiles: 1, addedLines: 2, deletedLines: 0, diffBytes: null, changedPaths: ["src/a.ts"], reasons: [] }, scope, evidence });
  assert.equal(captured.latency.harnessLatencyMs, 10); assert.equal(captured.completeness.status, "COMPLETE");
  const unsafe = captureObservationMetrics({ diff: { changedFiles: 1, addedLines: null, deletedLines: null, diffBytes: null, changedPaths: ["../outside"], reasons: ["DIFF_PATH_UNSAFE"] } });
  assert.ok(unsafe.diff.reasons.includes("DIFF_PATH_UNSAFE"));
});

test("manual intervention import is validated, append-only, idempotent, and redacted", () => {
  const root = mkdtempSync(join(tmpdir(), "bench-metrics-")); const path = join(root, "interventions.jsonl"); const hash = "a".repeat(64);
  const item = { schemaVersion: "1.0", id: "int-one", experimentHash: hash, observationId: "obs-one", occurredAt: "2026-01-01T00:00:00Z", kind: "review", actor: "human", activeMinutes: 2, reason: "review token=supersecret" };
  try {
    const written = appendIntervention(path, item); assert.match(written.reason, /\[REDACTED\]/); appendIntervention(path, item);
    assert.equal(readFileSync(path, "utf8").trim().split(/\r?\n/u).length, 1);
    assert.equal(importInterventions(path, [item]).length, 1);
    assert.throws(() => importInterventions(path, [{ ...item, id: "int-two", unknown: true }]), /Invalid/);
    assert.throws(() => importInterventions(path, [{ ...item, id: "int-two", activeMinutes: -1 }]), /Invalid/);
    assert.doesNotMatch(readFileSync(path, "utf8"), /supersecret/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("completeness is available per observation and aggregate with reasons", () => {
  const complete = metricCompleteness({ usage: usage(3, 2), latency: splitLatency({ elapsedMs: 10, providerLatencyMs: 5 }), diff: { changedFiles: 1, addedLines: 1, deletedLines: 0, diffBytes: 4, changedPaths: [], reasons: [] }, scope: assessScope({ changedPaths: [], allow: [] }), evidence: assessEvidence({ expected: 0, present: 0, traceExpected: 0, tracePresent: 0 }) });
  const partial = metricCompleteness({ usage: { inputUncachedTokens: null }, latency: null });
  assert.equal(complete.status, "COMPLETE"); assert.equal(partial.status, "UNKNOWN"); assert.equal(aggregateCompleteness([complete, partial]).status, "PARTIAL");
});

test("secret redaction covers bearer and provider key forms", () => {
  assert.equal(redactSecrets("Authorization: Bearer abcdefghijklmnop sk-abcdefghijklmnop"), "Authorization: Bearer [REDACTED] [REDACTED]");
  assert.doesNotMatch(redactSecrets('{"apiKey":"super-secret","token":"also-secret"}'), /super-secret|also-secret/);
});
