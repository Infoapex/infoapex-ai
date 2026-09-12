import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { defaultProductionPolicy, acquireLease, recoverStaleLease } from "../src/production.js";
import { EventLog } from "../src/state/event-log.js";
import { runFake } from "../src/run/fake-run.js";
import { runBoundedProcess } from "../src/run/process-control.js";

function repository(): string { const repo = mkdtempSync(join(tmpdir(), "infoapex-recovery-")); mkdirSync(join(repo, ".infoapex-ai"), { recursive: true }); writeFileSync(join(repo, ".infoapex-ai", "production-policy.json"), JSON.stringify(defaultProductionPolicy())); return repo; }
test("event writes are atomic, bounded, and duplicate ids are no-ops", () => {
  const repo = repository(); try {
    const log = new EventLog(join(repo, "events.json"), { maximumEvents: 1 }); const event = { eventId: "e1", runId: "r", type: "started", createdAt: "2026-01-01T00:00:00.000Z", payload: {} };
    assert.equal(log.append(event).appended, true); assert.equal(log.append(event).appended, false); assert.throws(() => log.append({ ...event, eventId: "e2" }), /bounded/);
    assert.equal(JSON.parse(readFileSync(join(repo, "events.json"), "utf8")).events.length, 1);
  } finally { rmSync(repo, { recursive: true, force: true }); }
});
test("resume after a durable task commit never repeats its gate or external action", () => {
  const repo = repository(); let gates = 0; let effects = 0; try {
    const task = { id: "T1", commit: "c1", gate: () => { gates += 1; }, externalAction: () => { effects += 1; return { accepted: true }; } };
    assert.equal(runFake({ repositoryRoot: repo, runId: "r1", tasks: [task], fault: "after-state-commit" }).status, "BLOCKED");
    assert.equal(runFake({ repositoryRoot: repo, runId: "r1", tasks: [task] }).status, "DONE");
    assert.equal(gates, 1); assert.equal(effects, 1);
  } finally { rmSync(repo, { recursive: true, force: true }); }
});
test("concurrent and stale leases are rejected or recovered explicitly", () => {
  const repo = repository(); try {
    assert.equal(acquireLease(repo, "first").status, "PASS"); assert.equal(acquireLease(repo, "second").status, "BLOCKED");
    const path = join(repo, ".infoapex-ai", "runtime", "lease.json"); const old = JSON.parse(readFileSync(path, "utf8")); old.acquiredAt = "2000-01-01T00:00:00.000Z"; writeFileSync(path, JSON.stringify(old));
    assert.equal(recoverStaleLease(repo, "second", { now: new Date("2026-01-01T00:00:00.000Z") }).status, "PASS");
  } finally { rmSync(repo, { recursive: true, force: true }); }
});
test("timeout and output caps produce terminal bounded process evidence", async () => {
  const timeout = await runBoundedProcess({ command: process.execPath, args: ["-e", "setTimeout(()=>{},1000)"], cwd: process.cwd(), timeoutMs: 10, maximumOutputBytes: 1000 }); assert.equal(timeout.code, "PROCESS_TIMEOUT");
  const output = await runBoundedProcess({ command: process.execPath, args: ["-e", "process.stdout.write('x'.repeat(100))"], cwd: process.cwd(), timeoutMs: 1000, maximumOutputBytes: 10 }); assert.equal(output.code, "OUTPUT_LIMIT");
});
