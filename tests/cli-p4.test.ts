import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";

// P4 (ADR-0003): the root CLI's new doctor/plan/run/resume/review/docs commands delegate
// to each module's OWN built CLI as a real subprocess - never a mock. registry.test.ts and
// delegate.test.ts cover the generic delegation machinery in isolation; these tests prove
// the wiring in src/cli.ts actually reaches a real module (ai-code-worker, exercised here
// because it is the fast/hermetic one via --engine fake) and produces the documented
// envelope shape end to end, mirroring the manual verification done against
// ai-code-planner/ai-code-review/ai-code-docs during P4 implementation.

const rootCliPath = resolve("dist/src/cli.js");
const workerCliPath = resolve("modules/ai-code-worker/dist/src/cli.js");

function runRootCli(repositoryPath: string, args: readonly string[]): { status: number; stdout: string; stderr: string } {
  try {
    const stdout = execFileSync(process.execPath, [rootCliPath, ...args], {
      cwd: repositoryPath,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"]
    });
    return { status: 0, stdout, stderr: "" };
  } catch (error) {
    const result = error as { status?: number; stdout?: string; stderr?: string };
    return { status: result.status ?? 1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
  }
}

function git(repositoryPath: string, args: readonly string[]): void {
  execFileSync("git", args, { cwd: repositoryPath, stdio: "ignore" });
}

// Mirrors the minimal fixture used across P2's live-pilot scripts: one trivial "test" task
// whose verify step is a no-op script, run under the `fake` engine so the test stays fast
// and hermetic (no real Codex/Claude CLI involved).
function createWorkerFixtureRepo(): string {
  const repository = realpathSync.native(mkdtempSync(join(tmpdir(), "p4-cli-fixture-")));
  mkdirSync(join(repository, "Plan"), { recursive: true });
  mkdirSync(join(repository, "scripts"), { recursive: true });
  writeFileSync(join(repository, "README.md"), "# P4 fixture\n", "utf8");
  writeFileSync(join(repository, "scripts", "pass.mjs"), "process.exit(0);\n", "utf8");
  const plan = {
    goal: "smoke",
    tasks: [
      {
        id: "TASK-01",
        kind: "test",
        role: "writer",
        dependsOn: [],
        requiredInputs: ["README.md"],
        allowedPaths: ["out.txt"],
        forbiddenPaths: [".git/**"],
        expectedArtifacts: ["out.txt"],
        acceptanceCriteria: ["write out.txt"],
        verify: ["node scripts/pass.mjs"],
        concurrencyKeys: ["seq"],
        risk: "low"
      }
    ],
    globalGates: ["node -e \"process.exit(0)\""],
    budgets: {
      maximumParallelWriters: 1,
      maximumRepairCycles: 0,
      maximumTaskMinutes: 5,
      maximumRunMinutes: 10,
      maximumAgentInvocations: 1,
      maximumRunInputUncachedTokens: 100000,
      maximumRunCacheReadTokens: 100000,
      maximumRunCacheWriteTokens: 100000,
      maximumRunOutputTokens: 20000,
      maximumRunCostUsd: null,
      onUnknownUsage: "allow"
    }
  };
  writeFileSync(
    join(repository, "Plan", "RUN.md"),
    `---\nstatus: accepted\n---\n\n# smoke\n\n\`\`\`json ai-code-worker-plan\n${JSON.stringify(plan, null, 2)}\n\`\`\`\n`,
    "utf8"
  );
  git(repository, ["init", "--initial-branch", "main"]);
  git(repository, ["config", "user.name", "Infoapex P4"]);
  git(repository, ["config", "user.email", "p4@example.invalid"]);
  git(repository, ["add", "."]);
  git(repository, ["commit", "-m", "p4 fixture"]);

  const init = execFileSync(process.execPath, [workerCliPath, "init", "--repo", repository, "--json"], { encoding: "utf8" });
  assert.equal(JSON.parse(init).status, "CREATED", init);
  git(repository, ["add", ".ai-code-worker"]);
  git(repository, ["commit", "-m", "worker config"]);
  return repository;
}

test("doctor aggregates every backing module and reports the worst status across them", () => {
  const repository = createWorkerFixtureRepo();
  try {
    const result = runRootCli(repository, ["doctor", "--repo", repository, "--engine", "fake"]);
    const envelope = JSON.parse(result.stdout) as {
      schemaVersion: string;
      command: string;
      status: string;
      exitCode: number;
      modules: Record<string, { status: string; module: string }>;
    };
    assert.equal(envelope.schemaVersion, "1.0");
    assert.equal(envelope.command, "doctor");
    // ai-code-review and ai-code-docs are never `init`'d for this fixture, so the
    // aggregate must come back BLOCKED even though ai-code-worker itself is healthy -
    // one unavailable/misconfigured module blocks the whole result, it is never
    // silently skipped (ADR-0003, "Missing module handling").
    assert.equal(envelope.status, "BLOCKED");
    assert.equal(result.status, envelope.exitCode);
    assert.equal(envelope.modules["ai-code-worker"]!.status, "PASS");
    assert.equal(envelope.modules["ai-code-review"]!.status, "BLOCKED");
    assert.equal(envelope.modules["ai-code-docs"]!.status, "BLOCKED");
  } finally {
    rmSync(repository, { recursive: true, force: true });
  }
});

test("run delegates to ai-code-worker and returns its full report as the envelope body", () => {
  const repository = createWorkerFixtureRepo();
  try {
    const result = runRootCli(repository, ["run", "--repo", repository, "--plan", "Plan/RUN.md", "--run-id", "p4-cli-run", "--engine", "fake"]);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const envelope = JSON.parse(result.stdout) as { command: string; module: string; status: string; body: { status: string; runId: string } };
    assert.equal(envelope.command, "run");
    assert.equal(envelope.module, "ai-code-worker");
    assert.equal(envelope.status, "PASS");
    assert.equal(envelope.body.status, "DONE");
    assert.equal(envelope.body.runId, "p4-cli-run");
  } finally {
    rmSync(repository, { recursive: true, force: true });
  }
});

test("resume rejects a run-id that was never started, without ever starting one under that id", () => {
  const repository = createWorkerFixtureRepo();
  try {
    const result = runRootCli(repository, [
      "resume", "--repo", repository, "--run-id", "does-not-exist", "--plan", "Plan/RUN.md", "--engine", "fake"
    ]);
    assert.notEqual(result.status, 0);
    const envelope = JSON.parse(result.stdout) as { status: string; body: { findings: readonly { code: string }[] } };
    assert.equal(envelope.status, "BLOCKED");
    assert.equal(envelope.body.findings[0]!.code, "RUN_NOT_FOUND");
  } finally {
    rmSync(repository, { recursive: true, force: true });
  }
});

test("resume continues a run that was already started via run", () => {
  const repository = createWorkerFixtureRepo();
  try {
    const first = runRootCli(repository, ["run", "--repo", repository, "--plan", "Plan/RUN.md", "--run-id", "p4-cli-resume", "--engine", "fake"]);
    assert.equal(first.status, 0, first.stderr || first.stdout);

    const resumed = runRootCli(repository, [
      "resume", "--repo", repository, "--run-id", "p4-cli-resume", "--plan", "Plan/RUN.md", "--engine", "fake"
    ]);
    assert.equal(resumed.status, 0, resumed.stderr || resumed.stdout);
    const envelope = JSON.parse(resumed.stdout) as { command: string; status: string; body: { status: string; runId: string } };
    assert.equal(envelope.command, "resume");
    assert.equal(envelope.status, "PASS");
    assert.equal(envelope.body.status, "DONE");
    assert.equal(envelope.body.runId, "p4-cli-resume");
  } finally {
    rmSync(repository, { recursive: true, force: true });
  }
});

test("an unrecognized top-level command is rejected with a usage message, not a crash", () => {
  // MODULE_NOT_AVAILABLE itself (a registry-declared module missing from disk) is covered
  // in delegate.test.ts, where a throwaway fixture bundle root makes it cheap to simulate
  // without touching any real module's dist output.
  const repository = createWorkerFixtureRepo();
  try {
    const result = runRootCli(repository, ["frobnicate", "--repo", repository]);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Usage: infoapex-ai/);
  } finally {
    rmSync(repository, { recursive: true, force: true });
  }
});

test("help, --help, and -h all print the full command reference and exit 0", () => {
  for (const flag of ["help", "--help", "-h"]) {
    const result = runRootCli(process.cwd(), [flag]);
    assert.equal(result.status, 0, result.stderr);
    for (const command of ["doctor", "plan", "run", "resume", "review", "docs", "init", "status", "handoff"]) {
      assert.match(result.stdout, new RegExp(`  ${command}\\b`), `help output is missing '${command}'`);
    }
  }
});
