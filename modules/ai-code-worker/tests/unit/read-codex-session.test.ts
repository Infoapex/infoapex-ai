import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { findLatestCodexRolloutPath, parseCodexSessionLog, readCodexSessionLog } from "../../src/benchmark/read-codex-session.js";

const tempRoots: string[] = [];

after(() => {
  for (const root of tempRoots) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("read-codex-session", () => {
  it("takes the LAST token_count event as the cumulative total, not a sum across events", () => {
    const content = readFileSync("tests/fixtures/engine-usage/codex-rollout-token-count.sample.jsonl", "utf8");
    const summary = parseCodexSessionLog(content);

    assert.deepEqual(summary.totalTokenUsage, {
      inputTokens: 83421,
      cachedInputTokens: 71200,
      outputTokens: 2114,
      totalTokens: 85535
    });
    assert.equal(summary.usedPercent, 86.0);
    assert.equal(summary.windowMinutes, 10080);
    assert.equal(summary.planType, "plus");
  });

  it("returns an empty summary when there is no token_count event", () => {
    const summary = parseCodexSessionLog('{"type":"thread.started","thread_id":"t"}\n{"type":"turn.started"}\n');

    assert.equal(summary.totalTokenUsage, null);
    assert.equal(summary.usedPercent, null);
  });

  it("extracts model, effort, context window, session id, and reset metadata without retaining transcript content", () => {
    const summary = parseCodexSessionLog(
      [
        JSON.stringify({ type: "session_meta", payload: { session_id: "session-123", context_window: 1_050_000 } }),
        JSON.stringify({ type: "turn_context", payload: { model: "gpt-5.6-sol", effort: "high" } }),
        JSON.stringify({
          type: "event_msg",
          payload: {
            type: "token_count",
            info: { total_token_usage: { input_tokens: 1000, cached_input_tokens: 800, output_tokens: 50, total_tokens: 1050 } },
            rate_limits: { primary: { used_percent: 12, window_minutes: 300, resets_at: 123456 }, plan_type: "plus" }
          }
        })
      ].join("\n")
    );

    assert.equal(summary.sessionId, "session-123");
    assert.equal(summary.model, "gpt-5.6-sol");
    assert.equal(summary.reasoningEffort, "high");
    assert.equal(summary.modelContextWindow, 1_050_000);
    assert.equal(summary.resetsAt, 123456);
  });

  it("returns null best-effort when the rollout file does not exist", () => {
    const missing = join(tmpdir(), "aicw-no-such-codex-rollout-xyz.jsonl");

    assert.equal(readCodexSessionLog(missing), null);
  });

  it("reads a real file from disk end to end", () => {
    const summary = readCodexSessionLog("tests/fixtures/engine-usage/codex-rollout-token-count.sample.jsonl");

    assert.equal(summary?.totalTokenUsage?.totalTokens, 85535);
    assert.equal(summary?.usedPercent, 86.0);
  });

  it("finds the most-recently-modified rollout file under the sessions directory tree", () => {
    const root = mkdtempSync(join(tmpdir(), "aicw-codex-sessions-"));
    tempRoots.push(root);
    const day = join(root, "2026", "08", "15");
    mkdirSync(day, { recursive: true });
    const older = join(day, "rollout-older.jsonl");
    const newer = join(day, "rollout-newer.jsonl");
    writeFileSync(older, "", "utf8");
    writeFileSync(newer, "", "utf8");
    const now = Date.now() / 1000;
    utimesSync(older, now - 100, now - 100);
    utimesSync(newer, now, now);

    const found = findLatestCodexRolloutPath({ codexSessionsDir: root });

    assert.equal(found, newer);
  });

  it("returns null when the sessions directory does not exist", () => {
    const missingRoot = join(tmpdir(), "aicw-codex-sessions-does-not-exist-xyz");

    assert.equal(findLatestCodexRolloutPath({ codexSessionsDir: missingRoot }), null);
  });
});
