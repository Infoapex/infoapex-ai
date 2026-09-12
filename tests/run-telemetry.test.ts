import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { redactTelemetryEvent, telemetrySummary } from "../src/telemetry/run-telemetry.js";

test("telemetry redaction keeps only the bounded SLO event contract", () => {
  const event = redactTelemetryEvent({ schemaVersion: "1.0", type: "terminal", outcome: "DONE", occurredAt: "2026-09-12T00:00:00.000Z", transcript: "secret", tokens: 123 });
  assert.deepEqual(event, { schemaVersion: "1.0", type: "terminal", outcome: "DONE", occurredAt: "2026-09-12T00:00:00.000Z" });
  assert.equal(redactTelemetryEvent({ type: "terminal", outcome: "DONE", occurredAt: "not-a-date" }), null);
});

test("telemetry remains local and reports invalid evidence without exporting it", () => {
  const repo = mkdtempSync(join(tmpdir(), "infoapex-telemetry-"));
  try {
    const root = join(repo, ".infoapex-ai", "telemetry"); mkdirSync(root, { recursive: true });
    writeFileSync(join(root, "events.jsonl"), `${JSON.stringify({ schemaVersion: "1.0", type: "terminal", outcome: "DONE", occurredAt: "2026-09-12T00:00:00Z", raw: "never-returned" })}\n${JSON.stringify({ schemaVersion: "1.0", type: "recovery", outcome: "RECOVERED", occurredAt: "2026-09-12T00:01:00Z" })}\n`);
    const summary = telemetrySummary(repo) as { status: string; export: string; events: number; measures: { terminalExplicit: number; recoverySucceeded: number } };
    assert.equal(summary.status, "PASS"); assert.equal(summary.export, "off"); assert.equal(summary.events, 2); assert.equal(summary.measures.terminalExplicit, 1); assert.equal(summary.measures.recoverySucceeded, 1);
    writeFileSync(join(root, "events.jsonl"), "not-json\n");
    assert.equal((telemetrySummary(repo) as { code: string }).code, "TELEMETRY_INVALID");
  } finally { rmSync(repo, { recursive: true, force: true }); }
});
