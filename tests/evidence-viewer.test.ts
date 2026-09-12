import { strict as assert } from "node:assert";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { buildEvidenceView } from "../src/evidence-viewer.js";

test("local evidence UI renders bounded metadata and omits raw payloads", () => {
  const repo = mkdtempSync(join(tmpdir(), "infoapex-ui-"));
  const run = join(repo, ".infoapex-ai", "runs", "ui-test");
  mkdirSync(run, { recursive: true });
  writeFileSync(join(run, "state.json"), JSON.stringify({ schemaVersion: "1.0", runId: "ui-test", provider: "fake", status: "DONE", createdAt: "2026-09-12T00:00:00Z", updatedAt: "2026-09-12T00:01:00Z", manifestSha256: "abc", tasks: { T1: { status: "GATED", commit: "deadbeef", gate: "PASS" } }, effects: {} }));
  writeFileSync(join(run, "events.json"), JSON.stringify({ schemaVersion: "1.0", events: [{ eventId: "e1", runId: "ui-test", type: "run.done", createdAt: "2026-09-12T00:01:00Z", payload: { secret: "do-not-render" } }], sha256: "not-checked-by-view" }));
  const result = buildEvidenceView(repo, "ui-test");
  assert.equal(result.status, "PASS");
  assert.match(result.html!, /ui-test/);
  assert.match(result.html!, /run\.done/);
  assert.doesNotMatch(result.html!, /do-not-render/);
  assert.match(result.html!, /Content-Security-Policy/);
});

test("local evidence UI rejects unsafe run ids", () => {
  const result = buildEvidenceView(".", "../outside");
  assert.deepEqual({ status: result.status, code: result.code }, { status: "BLOCKED", code: "RUN_ID_INVALID" });
});
