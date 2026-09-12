import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { after, describe, it } from "node:test";
import { runCompile } from "../../src/compile/compile.js";
import { freezeManifest } from "../../src/manifest/normalize.js";
import { EventLog } from "../../src/persistence/event-log.js";
import { runStatus } from "../../src/status/status.js";
import { resolveStateRoot } from "../../src/state/state-root.js";

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

describe("compile command", () => {
  it("compiles an accepted plan into external state and authorization", () => {
    const repo = createGitRepository();
    writePlan(repo, "Plan/ACCEPTED.md", "accepted");
    const beforeFiles = listRepositoryFiles(repo);
    const report = runCompile({
      repositoryPath: repo,
      planPath: "Plan/ACCEPTED.md",
      runId: "run-compile-1",
      now: "2026-08-01T10:00:00Z"
    });

    assert.equal(report.status, "PASS");
    assert.equal(report.runId, "run-compile-1");
    assert.ok(report.state.runRoot);
    assert.equal(report.state.runRoot?.startsWith(repo), false);
    assert.deepEqual(listRepositoryFiles(repo), beforeFiles);

    const manifest = JSON.parse(readFileSync(report.state.manifestPath!, "utf8"));
    const authorization = JSON.parse(readFileSync(report.state.authorizationPath!, "utf8"));
    const events = new EventLog(report.state.eventLogPath!).read().events;
    const status = runStatus({
      repositoryPath: repo,
      runId: "run-compile-1",
      now: "2026-08-01T10:01:00Z"
    });

    assert.equal(report.manifestSha256, freezeManifest(manifest).sha256);
    assert.equal(authorization.manifestSha256, report.manifestSha256);
    assert.deepEqual(
      events.map((event) => event.type),
      ["run.created", "run.intent-created", "manifest.compiled", "manifest.frozen", "authorization.bound"]
    );
    assert.equal(status.run.status, "AUTHORIZED");
  });

  it("uses the repository's configured external stateRoot for compile and status", () => {
    const repo = createGitRepository();
    const configuredRoot = mkdtempSync(join(tmpdir(), "aicw-configured-state-"));
    stateRoots.push(configuredRoot);
    mkdirSync(join(repo, ".ai-code-worker"), { recursive: true });
    writeFileSync(join(repo, ".ai-code-worker", "config.json"), JSON.stringify({ stateRoot: configuredRoot }, null, 2), "utf8");
    execFileSync("git", ["add", ".ai-code-worker/config.json"], { cwd: repo, stdio: "ignore" });
    execFileSync("git", ["-c", "user.name=ai-code-worker", "-c", "user.email=worker@example.test", "commit", "-m", "worker config"], { cwd: repo, stdio: "ignore" });
    writePlan(repo, "Plan/CONFIGURED-STATE.md", "accepted");
    execFileSync("git", ["add", "Plan/CONFIGURED-STATE.md"], { cwd: repo, stdio: "ignore" });
    execFileSync("git", ["-c", "user.name=ai-code-worker", "-c", "user.email=worker@example.test", "commit", "-m", "accepted plan"], { cwd: repo, stdio: "ignore" });

    const report = runCompile({ repositoryPath: repo, planPath: "Plan/CONFIGURED-STATE.md", runId: "run-configured-state", now: "2026-08-01T10:00:00Z" });
    assert.equal(report.status, "PASS");
    assert.equal(report.state.runRoot, join(configuredRoot, "runs", "run-configured-state"));
    const status = runStatus({ repositoryPath: repo, runId: "run-configured-state", now: "2026-08-01T10:01:00Z" });
    assert.equal(status.run.status, "AUTHORIZED");
    assert.equal(status.eventLog.path, join(configuredRoot, "runs", "run-configured-state", "events.jsonl"));
  });

  it("blocks proposed plans before writing run state", () => {
    const repo = createGitRepository();
    writePlan(repo, "Plan/PROPOSED.md", "proposed");
    const stateRoot = resolveStateRoot({ repoRoot: repo }).path;
    stateRoots.push(stateRoot);
    rmSync(stateRoot, { recursive: true, force: true });

    const report = runCompile({
      repositoryPath: repo,
      planPath: "Plan/PROPOSED.md",
      runId: "run-proposed",
      now: "2026-08-01T10:00:00Z"
    });

    assert.equal(report.status, "BLOCKED");
    assert.equal(report.findings[0]?.code, "PLAN_NOT_ACCEPTED");
    assert.equal(existsSync(join(stateRoot, "runs", "run-proposed")), false);
  });

  it("fails closed when the execution environment profile cannot be parsed", () => {
    const repo = createGitRepository();
    writePlan(repo, "Plan/INVALID-ENVIRONMENT.md", "accepted");
    mkdirSync(join(repo, ".ai-code-worker"), { recursive: true });
    writeFileSync(join(repo, ".ai-code-worker", "execution-environment.example.json"), "{ invalid", "utf8");

    const report = runCompile({
      repositoryPath: repo,
      planPath: "Plan/INVALID-ENVIRONMENT.md",
      runId: "run-invalid-environment",
      now: "2026-08-01T10:00:00Z"
    });

    assert.equal(report.status, "BLOCKED");
    assert.equal(report.findings[0]?.code, "EXECUTION_ENVIRONMENT_INVALID");
    assert.equal(report.state.runRoot, null);
  });

  it("compiles a v1.1 plan without losing criterion, gate, or evidence-contract identifiers", () => {
    const repo = createGitRepository();
    writePlan(repo, "Plan/TRACEABLE.md", "accepted", traceablePlanBody());
    const report = runCompile({
      repositoryPath: repo,
      planPath: "Plan/TRACEABLE.md",
      runId: "run-traceable",
      now: "2026-08-01T10:00:00Z"
    });

    assert.equal(report.status, "PASS");
    const manifest = JSON.parse(readFileSync(report.state.manifestPath!, "utf8"));
    assert.equal(manifest.schemaVersion, "1.1");
    assert.deepEqual(manifest.tasks[0].traceability, {
      acceptanceCriteria: [{ criterionId: "AC-T1-01", text: "Compile writes manifest and authorization outside the repository." }],
      gates: [{
        gateId: "G-T1-01",
        command: "npm test",
        evidenceContract: "The command exits with code zero.",
        criterionIds: ["AC-T1-01"]
      }]
    });
  });

  it("blocks a v1.1 manifest when executable strings drift from traceability", () => {
    const repo = createGitRepository();
    const body = traceablePlanBody();
    body.tasks[0]!.acceptanceCriteria = ["A different criterion text."];
    writePlan(repo, "Plan/TRACE-DRIFT.md", "accepted", body);
    const report = runCompile({
      repositoryPath: repo,
      planPath: "Plan/TRACE-DRIFT.md",
      runId: "run-trace-drift",
      now: "2026-08-01T10:00:00Z"
    });

    assert.equal(report.status, "BLOCKED");
    assert.equal(report.findings[0]?.code, "MANIFEST_TRACEABILITY_INVALID");
    assert.match(report.findings[0]?.message ?? "", /acceptance criteria do not match/);
  });

  it("returns existing frozen run state without appending duplicate compile events", () => {
    const repo = createGitRepository();
    writePlan(repo, "Plan/ACCEPTED.md", "accepted");
    const first = runCompile({
      repositoryPath: repo,
      planPath: "Plan/ACCEPTED.md",
      runId: "run-idempotent",
      now: "2026-08-01T10:00:00Z"
    });
    const second = runCompile({
      repositoryPath: repo,
      planPath: "Plan/ACCEPTED.md",
      runId: "run-idempotent",
      now: "2026-08-01T10:05:00Z"
    });
    const events = new EventLog(first.state.eventLogPath!).read().events;

    assert.equal(second.status, "PASS");
    assert.equal(second.manifestSha256, first.manifestSha256);
    assert.equal(events.length, 5);
  });

  it("exposes compile as a JSON CLI command", () => {
    const repo = createGitRepository();
    writePlan(repo, "Plan/ACCEPTED.md", "accepted");
    const output = execFileSync(
      process.execPath,
      [resolve("dist/src/cli.js"), "compile", "--repo", repo, "--plan", "Plan/ACCEPTED.md", "--run-id", "run-cli", "--json"],
      { cwd: tmpdir(), encoding: "utf8" }
    );
    const report = JSON.parse(output) as { status: string; runId: string };

    assert.equal(report.status, "PASS");
    assert.equal(report.runId, "run-cli");
  });
});

function createGitRepository(): string {
  const repo = mkdtempSync(join(tmpdir(), "aicw-compile-"));
  tempRepos.push(repo);
  stateRoots.push(resolveStateRoot({ repoRoot: repo }).path);

  execFileSync("git", ["init"], { cwd: repo, stdio: "ignore" });
  writeFileSync(join(repo, "README.md"), "# fixture\n");
  execFileSync("git", ["add", "README.md"], { cwd: repo, stdio: "ignore" });
  execFileSync("git", ["-c", "user.name=ai-code-worker", "-c", "user.email=worker@example.test", "commit", "-m", "init"], {
    cwd: repo,
    stdio: "ignore"
  });

  return repo;
}

function writePlan(
  repo: string,
  path: string,
  status: "accepted" | "proposed",
  body: ReturnType<typeof planBody> = planBody()
): void {
  const fullPath = join(repo, ...path.split("/"));
  execFileSync("git", ["checkout", "-B", "main"], { cwd: repo, stdio: "ignore" });
  mkdirSync(dirname(fullPath), { recursive: true });
  writeFileSync(
    fullPath,
    `---\nstatus: ${status}\n---\n\n# Test plan\n\n\`\`\`json ai-code-worker-plan\n${JSON.stringify(body, null, 2)}\n\`\`\`\n`,
    "utf8"
  );
}

function planBody(): {
  goal: string;
  tasks: Array<Record<string, unknown>>;
  globalGates: string[];
  budgets: Record<string, unknown>;
} {
  return {
    goal: "Compile a deterministic Phase 0 fixture.",
    tasks: [
      {
        id: "T1",
        kind: "test",
        role: "phase0-worker",
        dependsOn: [],
        requiredInputs: ["README.md"],
        allowedPaths: ["src/**"],
        forbiddenPaths: [".git/**"],
        expectedArtifacts: ["dist/src/cli.js"],
        acceptanceCriteria: ["Compile writes manifest and authorization outside the repository."],
        verify: ["npm test"],
        concurrencyKeys: ["compile"],
        risk: "low"
      }
    ],
    globalGates: ["npm test"],
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
      onUnknownUsage: "block"
    }
  };
}

function traceablePlanBody(): ReturnType<typeof planBody> & { workerContractVersion: "1.1" } {
  const body = planBody();
  return {
    workerContractVersion: "1.1",
    ...body,
    tasks: body.tasks.map((task) => ({
      ...task,
      traceability: {
        acceptanceCriteria: [{
          criterionId: "AC-T1-01",
          text: "Compile writes manifest and authorization outside the repository."
        }],
        gates: [{
          gateId: "G-T1-01",
          command: "npm test",
          evidenceContract: "The command exits with code zero.",
          criterionIds: ["AC-T1-01"]
        }]
      }
    }))
  };
}

function listRepositoryFiles(repo: string): string[] {
  return readdirSync(repo, { recursive: true })
    .map((entry) => String(entry).replaceAll("\\", "/"))
    .filter((entry) => !entry.startsWith(".git/") && entry !== ".git")
    .sort();
}
