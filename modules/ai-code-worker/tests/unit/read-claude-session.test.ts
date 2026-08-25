import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { findClaudeSessionLogPath, parseClaudeSessionLog, readClaudeSessionLog } from "../../src/benchmark/read-claude-session.js";

const tempRoots: string[] = [];

after(() => {
  for (const root of tempRoots) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("read-claude-session", () => {
  it("parses per-turn usage and estimates current context from the last turn only", () => {
    const content = readFixture("tests/fixtures/engine-usage/claude-session-transcript.sample.jsonl");
    const summary = parseClaudeSessionLog(content);

    assert.equal(summary.turns.length, 2);
    assert.deepEqual(summary.turns[0], {
      inputTokens: 120,
      cacheReadTokens: 0,
      cacheCreationTokens: 8000,
      outputTokens: 45
    });
    assert.deepEqual(summary.turns[1], {
      inputTokens: 90,
      cacheReadTokens: 8000,
      cacheCreationTokens: 1500,
      outputTokens: 220
    });
    // Last turn only: 90 + 8000 + 1500 - NOT a sum across both turns (that would
    // double-count, see the field doc in read-claude-session.ts).
    assert.equal(summary.estimatedContextTokens, 9590);
  });

  it("ignores non-assistant lines and lines without usage", () => {
    const summary = parseClaudeSessionLog(
      ['{"type":"user","message":{"role":"user","content":"hi"}}', "not json", ""].join("\n")
    );

    assert.equal(summary.turns.length, 0);
    assert.equal(summary.estimatedContextTokens, null);
  });

  it("returns null best-effort when the session log file does not exist", () => {
    const missing = join(tmpdir(), "aicw-no-such-claude-session-xyz.jsonl");

    assert.equal(readClaudeSessionLog(missing), null);
  });

  it("reads a real file from disk end to end", () => {
    const summary = readClaudeSessionLog("tests/fixtures/engine-usage/claude-session-transcript.sample.jsonl");

    assert.equal(summary?.turns.length, 2);
    assert.equal(summary?.estimatedContextTokens, 9590);
  });

  it("finds a session log by scanning project directories, without recomputing the project-hash algorithm", () => {
    const root = mkdtempSync(join(tmpdir(), "aicw-claude-projects-"));
    tempRoots.push(root);
    const projectDir = join(root, "some-project-hash");
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(join(projectDir, "session-abc.jsonl"), "", "utf8");

    const found = findClaudeSessionLogPath("session-abc", { claudeProjectsDir: root });

    assert.equal(found, join(projectDir, "session-abc.jsonl"));
  });

  it("returns null when no project has that session (e.g. --no-session-persistence headless runs)", () => {
    const root = mkdtempSync(join(tmpdir(), "aicw-claude-projects-empty-"));
    tempRoots.push(root);

    assert.equal(findClaudeSessionLogPath("no-such-session", { claudeProjectsDir: root }), null);
  });

  it("returns null when the projects directory itself does not exist", () => {
    const missingRoot = join(tmpdir(), "aicw-claude-projects-does-not-exist-xyz");

    assert.equal(findClaudeSessionLogPath("session-abc", { claudeProjectsDir: missingRoot }), null);
  });
});

function readFixture(path: string): string {
  return readFileSync(path, "utf8");
}
