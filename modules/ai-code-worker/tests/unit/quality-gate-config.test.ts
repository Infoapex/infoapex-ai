import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { resolveQualityGate, splitCommand } from "../../src/runner/quality-gate-config.js";

const tempRoots: string[] = [];

after(() => {
  for (const root of tempRoots) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("quality gate config", () => {
  it("resolves configured gate ids into command specs", () => {
    const repo = createRepoWithQualityGate();
    const result = resolveQualityGate({
      repositoryRoot: repo,
      executionRoot: repo,
      gate: "unit-fast",
      defaultTimeoutMs: 1000,
      env: { AICW_TEST_ALLOWED: "yes", AICW_TEST_DENIED: "no" }
    });

    assert.equal(result.status, "PASS");
    assert.equal(result.command?.id, "unit-fast");
    assert.deepEqual(result.command?.args, ["-e", "process.exit(0)"]);
    assert.deepEqual(result.command?.env, { AICW_TEST_ALLOWED: "yes" });
  });

  it("parses simple command strings without shell metacharacters", () => {
    assert.deepEqual(splitCommand('node -e "process.exit(0)"'), ["node", "-e", "process.exit(0)"]);
    assert.equal(splitCommand("node -e process.exit(0) && rm -rf ."), null);

    const repo = mkdtempSync(join(tmpdir(), "aicw-gate-command-"));
    tempRoots.push(repo);
    const result = resolveQualityGate({
      repositoryRoot: repo,
      executionRoot: repo,
      gate: 'node -e "process.exit(0)"',
      defaultTimeoutMs: 1000
    });

    assert.equal(result.status, "PASS");
    assert.equal(result.command?.executable, "node");
  });

  it("blocks missing gate ids and unsafe command strings", () => {
    const repo = createRepoWithQualityGate();
    const result = resolveQualityGate({
      repositoryRoot: repo,
      executionRoot: repo,
      gate: "missing-gate",
      defaultTimeoutMs: 1000
    });

    assert.equal(result.status, "BLOCKED");
    assert.equal(result.finding?.code, "QUALITY_GATE_NOT_FOUND");

    const unsafe = resolveQualityGate({
      repositoryRoot: repo,
      executionRoot: repo,
      gate: "unit-fast && deploy",
      defaultTimeoutMs: 1000
    });

    assert.equal(unsafe.status, "BLOCKED");
    assert.equal(unsafe.finding?.code, "QUALITY_GATE_NOT_FOUND");
  });

  it("links declared runtime directories from the repository into the task worktree", () => {
    const repo = createRepoWithQualityGate({
      linkedDirectories: [{ fromRepository: "node_modules", toWorktree: "node_modules" }]
    });
    const worktree = mkdtempSync(join(tmpdir(), "aicw-gate-worktree-"));
    tempRoots.push(worktree);
    mkdirSync(join(repo, "node_modules"), { recursive: true });
    writeFileSync(join(repo, "node_modules", ".fixture"), "ok", "utf8");

    const result = resolveQualityGate({
      repositoryRoot: repo,
      executionRoot: worktree,
      gate: "unit-fast",
      defaultTimeoutMs: 1000
    });

    assert.equal(result.status, "PASS");
    assert.equal(existsSync(join(worktree, "node_modules")), true);
    assert.equal(result.command?.linkedDirectories?.[0]?.to, join(worktree, "node_modules"));
  });
});

function createRepoWithQualityGate(options: { readonly linkedDirectories?: readonly unknown[] } = {}): string {
  const repo = mkdtempSync(join(tmpdir(), "aicw-gate-config-"));
  tempRoots.push(repo);
  mkdirSync(join(repo, ".ai-code-worker"), { recursive: true });
  writeFileSync(
    join(repo, ".ai-code-worker", "quality-gates.json"),
    JSON.stringify(
      {
        schemaVersion: "1.0",
        gates: [
          {
            id: "unit-fast",
            description: "Fast unit gate.",
            workingDirectory: ".",
            executable: "node",
            args: ["-e", "process.exit(0)"],
            timeoutSeconds: 1,
            allowedEnvironmentVariables: ["AICW_TEST_ALLOWED"],
            ...(options.linkedDirectories ? { linkedDirectories: options.linkedDirectories } : {})
          }
        ]
      },
      null,
      2
    )
  );

  return repo;
}
