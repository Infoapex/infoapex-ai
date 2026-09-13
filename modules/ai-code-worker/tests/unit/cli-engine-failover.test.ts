import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, describe, it } from "node:test";
import { writeFakeClaudeCli } from "../../src/engines/claude-cli.js";
import { writeFakeCodexCli } from "../../src/engines/codex-cli.js";

const tempRepos: string[] = [];
const tempRoots: string[] = [];

after(() => {
  for (const root of tempRoots) {
    rmSync(root, { recursive: true, force: true });
  }
  for (const repo of tempRepos) {
    rmSync(repo, { recursive: true, force: true });
  }
});

interface RunCliReport {
  readonly status: string;
  readonly engineProvenance: {
    readonly requestedEngine: string;
    readonly engineUsed: string;
    readonly engineFallbackTriggered: boolean;
    readonly reviewEngine: string | null;
  };
}

function invokeRunJson(args: readonly string[]): RunCliReport {
  let output: string;
  try {
    output = execFileSync(process.execPath, [resolve("dist/src/cli.js"), "run", "--json", "--execution-backend", "fake", ...args], {
      cwd: tmpdir(),
      encoding: "utf8"
    });
  } catch (error) {
    output = (error as { readonly stdout?: string }).stdout ?? "";
  }

  return JSON.parse(output) as RunCliReport;
}

/** --codex-executable/--claude-executable set the spawned executable
 *  directly, with no CLI flag for baseArgs - unlike claude-run.test.ts and
 *  friends, which invoke writeFakeClaudeCli's .mjs output in-process via
 *  { executable: process.execPath, baseArgs: [cli] }, a real subprocess CLI
 *  invocation needs something directly executable. The .mjs script's
 *  shebang doesn't help on Windows (shebangs aren't interpreted), so wrap
 *  it in a directly-runnable launcher: `node <script>` via a .cmd on
 *  Windows, or the script itself (already chmod +x, shebang works) on
 *  POSIX. Same wrapping trick tests/unit/cli-executable-flags.test.ts's
 *  writeFakeCli already relies on for its own lighter doctor-only fakes.
 */
function wrapAsExecutable(scriptPath: string): string {
  if (process.platform !== "win32") {
    return scriptPath;
  }

  const wrapperPath = `${scriptPath}.cmd`;
  writeFileSync(wrapperPath, `@echo off\r\n"${process.execPath}" "${scriptPath}" %*\r\n`, "utf8");
  return wrapperPath;
}

function fakeClaudeCli(touchedFile: string): string {
  const root = mkdtempSync(join(tmpdir(), "aicw-cli-failover-claude-"));
  tempRoots.push(root);
  const cli = join(root, "claude-fake.mjs");
  writeFakeClaudeCli(cli, { version: "2.1.177", touchedFile });
  chmodSync(cli, 0o755);
  return wrapAsExecutable(cli);
}

function fakeCodexCli(touchedFile: string): string {
  const root = mkdtempSync(join(tmpdir(), "aicw-cli-failover-codex-"));
  tempRoots.push(root);
  const cli = join(root, "codex-fake.mjs");
  writeFakeCodexCli(cli, { version: "0.146.0-alpha.3.1", touchedFile });
  chmodSync(cli, 0o755);
  return wrapAsExecutable(cli);
}

/** A path that cannot resolve to any executable - forces doctor() to
 *  CLAUDE_VERSION_UNAVAILABLE / CODEX_VERSION_UNAVAILABLE, the clean,
 *  reliably-detectable "engine unavailable before any task starts" signal
 *  --fallback-engine is deliberately scoped to (see the comment in cli.ts). */
function unavailableExecutable(): string {
  const root = mkdtempSync(join(tmpdir(), "aicw-cli-failover-missing-"));
  tempRoots.push(root);
  return join(root, "does-not-exist-binary");
}

function createGitRepositoryWithPlan(planBody: unknown): string {
  const repo = mkdtempSync(join(tmpdir(), "aicw-cli-failover-repo-"));
  tempRepos.push(repo);

  mkdirSync(join(repo, "Plan"), { recursive: true });
  writeFileSync(join(repo, "README.md"), "# fixture\n", "utf8");
  writeFileSync(
    join(repo, "Plan", "RUN.md"),
    `---
status: accepted
---

# CLI failover fixture plan

\`\`\`json ai-code-worker-plan
${JSON.stringify(planBody, null, 2)}
\`\`\`
`,
    "utf8"
  );
  execFileSync("git", ["init"], { cwd: repo, stdio: "ignore" });
  execFileSync("git", ["add", "."], { cwd: repo, stdio: "ignore" });
  execFileSync("git", ["-c", "user.name=ai-code-worker", "-c", "user.email=worker@example.test", "commit", "-m", "fixture"], {
    cwd: repo,
    stdio: "ignore"
  });

  return repo;
}

function simplePlanBody(): unknown {
  return {
    goal: "Execute a single task whose review passes on its own verify command.",
    tasks: [
      {
        id: "TASK-01",
        kind: "backend",
        role: "cli-failover-worker",
        dependsOn: [],
        requiredInputs: ["README.md"],
        allowedPaths: ["src/**"],
        forbiddenPaths: [".git/**"],
        expectedArtifacts: ["src/output.txt"],
        acceptanceCriteria: ["The engine writes the expected output file."],
        verify: ['node -e "process.exit(require(\'fs\').existsSync(\'src/output.txt\') ? 0 : 1)"'],
        concurrencyKeys: ["cli-failover"],
        risk: "low"
      }
    ],
    globalGates: ['node -e "process.exit(0)"'],
    budgets: {
      maximumParallelWriters: 1,
      maximumRepairCycles: 0,
      maximumTaskMinutes: 10,
      maximumRunMinutes: 30,
      maximumAgentInvocations: 1,
      maximumRunInputUncachedTokens: 100000,
      maximumRunCacheReadTokens: 100000,
      maximumRunCacheWriteTokens: 100000,
      maximumRunOutputTokens: 20000,
      maximumRunCostUsd: null,
      onUnknownUsage: "allow"
    }
  };
}

describe("cli run - engine failover and cross-engine review", () => {
  it("falls back to the working engine when the primary engine is unavailable, and reports it", () => {
    const repo = createGitRepositoryWithPlan(simplePlanBody());
    const workingClaude = fakeClaudeCli("src/output.txt");

    const report = invokeRunJson([
      "--repo", repo,
      "--plan", "Plan/RUN.md",
      "--engine", "codex",
      "--codex-executable", unavailableExecutable(),
      "--fallback-engine", "claude",
      "--claude-executable", workingClaude,
      "--claude-model", "test"
    ]);

    assert.equal(report.status, "DONE");
    assert.equal(report.engineProvenance.requestedEngine, "codex");
    assert.equal(report.engineProvenance.engineUsed, "claude");
    assert.equal(report.engineProvenance.engineFallbackTriggered, true);
  });

  it("does not trigger fallback when the primary engine is available", () => {
    const repo = createGitRepositoryWithPlan(simplePlanBody());
    const workingCodex = fakeCodexCli("src/output.txt");
    const workingClaude = fakeClaudeCli("src/output.txt");

    const report = invokeRunJson([
      "--repo", repo,
      "--plan", "Plan/RUN.md",
      "--engine", "codex",
      "--codex-executable", workingCodex,
      "--fallback-engine", "claude",
      "--claude-executable", workingClaude
    ]);

    assert.equal(report.status, "DONE");
    assert.equal(report.engineProvenance.engineUsed, "codex");
    assert.equal(report.engineProvenance.engineFallbackTriggered, false);
  });

  it("selects the cross-engine reviewer by default when --independent-review is on and both engines are available", () => {
    const repo = createGitRepositoryWithPlan(simplePlanBody());
    const workingCodex = fakeCodexCli("src/output.txt");
    const workingClaude = fakeClaudeCli("src/output.txt");

    const report = invokeRunJson([
      "--repo", repo,
      "--plan", "Plan/RUN.md",
      "--engine", "codex",
      "--codex-executable", workingCodex,
      "--independent-review",
      "--claude-executable", workingClaude
    ]);

    assert.equal(report.status, "DONE");
    assert.equal(report.engineProvenance.reviewEngine, "claude");
  });

  it("falls back to same-engine review, with the run still succeeding, when the cross engine is unavailable", () => {
    const repo = createGitRepositoryWithPlan(simplePlanBody());
    const workingCodex = fakeCodexCli("src/output.txt");

    const report = invokeRunJson([
      "--repo", repo,
      "--plan", "Plan/RUN.md",
      "--engine", "codex",
      "--codex-executable", workingCodex,
      "--independent-review",
      "--claude-executable", unavailableExecutable()
    ]);

    assert.equal(report.status, "DONE");
    assert.equal(report.engineProvenance.reviewEngine, "codex");
  });
});
