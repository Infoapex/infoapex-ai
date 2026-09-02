import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, describe, it } from "node:test";
import { resolveStateRoot } from "../../src/state/state-root.js";

// SimpleSpanProcessor + a synchronous local exporter were chosen specifically (ADR-0012)
// so enabling telemetry never needs an async shutdown and never keeps the process alive
// past its normal exit. This spawns the real built CLI (not an in-process call) with a
// tight timeout so a regression that introduces a lingering timer/handle fails loudly as
// a timeout instead of silently hanging future `npm test` runs.

const tempRepos: string[] = [];
const stateRoots: string[] = [];

after(() => {
  for (const root of stateRoots) {
    rmSync(root, { recursive: true, force: true });
  }
  for (const repo of tempRepos) {
    rmSync(repo, { recursive: true, force: true });
  }
});

describe("telemetry: CLI process exits promptly with OTel enabled", () => {
  it("runs to completion within a generous bound with INFOAPEX_OTEL_ENABLED=1", () => {
    const repo = createFixtureRepository();

    // A standalone run of this fixture finishes in ~6s; 60s leaves ample headroom for
    // CPU contention when the full suite runs many test files concurrently, while still
    // being finite enough to fail loudly on a genuine hang (which this bound cannot
    // plausibly be confused with - see the file header comment).
    const output = execFileSync(process.execPath, [resolve("dist/src/cli.js"), "run", "--repo", repo, "--plan", "Plan/RUN.md", "--engine", "fake", "--json"], {
      cwd: tmpdir(),
      encoding: "utf8",
      timeout: 60_000,
      env: { ...process.env, INFOAPEX_OTEL_ENABLED: "1" }
    });

    const report = JSON.parse(output) as { status: string; state: { runRoot: string } };
    assert.equal(report.status, "DONE");
    assert.equal(existsSync(join(report.state.runRoot, "otel-spans.jsonl")), true);
  });
});

function createFixtureRepository(): string {
  const repo = mkdtempSync(join(tmpdir(), "aicw-otel-cli-"));
  tempRepos.push(repo);
  stateRoots.push(resolveStateRoot({ repoRoot: repo }).path);

  execFileSync("git", ["init"], { cwd: repo, stdio: "ignore" });
  mkdirSync(join(repo, "Plan"), { recursive: true });
  writeFileSync(join(repo, "README.md"), "# fixture\n", "utf8");
  writeFileSync(
    join(repo, "Plan", "RUN.md"),
    `---
status: accepted
---

# OTel CLI fixture plan

\`\`\`json ai-code-worker-plan
${JSON.stringify(
  {
    goal: "Execute a deterministic fake task flow.",
    tasks: [
      {
        id: "CONTRACT-01",
        kind: "contract",
        role: "phase0-worker",
        dependsOn: [],
        requiredInputs: ["README.md"],
        allowedPaths: ["schemas/**"],
        forbiddenPaths: [".git/**"],
        expectedArtifacts: [],
        acceptanceCriteria: ["Contract task receives an empty dependency snapshot."],
        verify: ['node -e "process.exit(0)"'],
        concurrencyKeys: ["fake-run"],
        risk: "low"
      }
    ],
    globalGates: ['node -e "process.exit(0)"'],
    budgets: {
      maximumParallelWriters: 1,
      maximumRepairCycles: 0,
      maximumTaskMinutes: 10,
      maximumRunMinutes: 30,
      maximumAgentInvocations: 2,
      maximumRunInputUncachedTokens: 100000,
      maximumRunCacheReadTokens: 100000,
      maximumRunCacheWriteTokens: 100000,
      maximumRunOutputTokens: 20000,
      maximumRunCostUsd: null,
      onUnknownUsage: "block"
    }
  },
  null,
  2
)}
\`\`\`
`,
    "utf8"
  );
  execFileSync("git", ["add", "."], { cwd: repo, stdio: "ignore" });
  execFileSync("git", ["-c", "user.name=ai-code-worker", "-c", "user.email=worker@example.test", "commit", "-m", "otel cli fixture"], {
    cwd: repo,
    env: { ...process.env, GIT_AUTHOR_DATE: "2026-08-01T10:00:00Z", GIT_COMMITTER_DATE: "2026-08-01T10:00:00Z" },
    stdio: "ignore"
  });

  return repo;
}
