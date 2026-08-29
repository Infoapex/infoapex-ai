import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, describe, it } from "node:test";

const tempRoots: string[] = [];

after(() => {
  for (const root of tempRoots) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("benchmark CLI", () => {
  it("captures bounded development checkpoints and reports drift without a provider call", () => {
    const root = mkdtempSync(join(tmpdir(), "aicw-benchmark-cli-"));
    tempRoots.push(root);
    const repo = join(root, "repo");
    const state = join(root, "state");
    const sessions = join(root, "sessions");
    const rollout = join(sessions, "2026", "08", "28", "rollout-test.jsonl");
    mkdirSync(repo, { recursive: true });
    mkdirSync(join(sessions, "2026", "08", "28"), { recursive: true });
    writeRollout(rollout, 1000, 51);

    const common = [
      "benchmark",
      "checkpoint",
      "--repo",
      repo,
      "--plan",
      "ICM",
      "--stage",
      "ICM-00",
      "--engine",
      "codex",
      "--session-log",
      rollout,
      "--codex-sessions-dir",
      sessions,
      "--json"
    ];
    const env = { ...process.env, LOCALAPPDATA: state };
    const start = JSON.parse(
      execFileSync(
        process.execPath,
        [resolve("dist/src/cli.js"), ...common, "--phase", "start", "--kind", "backend", "--risk", "high", "--predicted-low", "500", "--predicted-median", "600", "--predicted-high", "700", "--prediction-source", "plan"],
        { encoding: "utf8", env }
      )
    ) as { schemaVersion: string; model: string; reasoningEffort: string };
    assert.equal(start.schemaVersion, "1.1");
    assert.equal(start.model, "gpt-5.6-sol");
    assert.equal(start.reasoningEffort, "high");

    writeRollout(rollout, 1600, 55);
    execFileSync(process.execPath, [resolve("dist/src/cli.js"), ...common, "--phase", "end"], { encoding: "utf8", env });
    const report = JSON.parse(
      execFileSync(
        process.execPath,
        [resolve("dist/src/cli.js"), "benchmark", "drift", "--repo", repo, "--plan", "ICM", "--profile", "codex:gpt-5.6-sol:high", "--json"],
        { encoding: "utf8", env }
      )
    ) as { status: string; stages: readonly { actualTokens: number }[] };

    assert.equal(report.status, "GREEN");
    assert.equal(report.stages[0]?.actualTokens, 600);
  });
});

function writeRollout(path: string, totalTokens: number, usedPercent: number): void {
  const cached = Math.floor(totalTokens * 0.8);
  const output = Math.floor(totalTokens * 0.05);
  const input = totalTokens - output;
  const lines = [
    { type: "session_meta", payload: { session_id: "session-test", context_window: 1_050_000 } },
    { type: "turn_context", payload: { model: "gpt-5.6-sol", effort: "high" } },
    {
      type: "event_msg",
      payload: {
        type: "token_count",
        info: { total_token_usage: { input_tokens: input, cached_input_tokens: cached, output_tokens: output, total_tokens: totalTokens } },
        rate_limits: { primary: { used_percent: usedPercent, window_minutes: 300, resets_at: 9999999999 }, plan_type: "plus" }
      }
    }
  ];
  writeFileSync(path, `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`, "utf8");
}
