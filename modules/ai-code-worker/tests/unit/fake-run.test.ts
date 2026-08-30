import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { after, describe, it } from "node:test";
import { runFake } from "../../src/run/fake-run.js";
import { SchemaRegistry } from "../../src/schema/json-schema.js";
import { runStatus } from "../../src/status/status.js";
import { resolveStateRoot } from "../../src/state/state-root.js";

const tempRepos: string[] = [];
const stateRoots: string[] = [];
const registry = SchemaRegistry.load({ schemaDirectory: "schemas" });

after(() => {
  for (const root of stateRoots) {
    rmSync(root, { recursive: true, force: true });
  }

  for (const repo of tempRepos) {
    rmSync(repo, { recursive: true, force: true });
  }
});

describe("fake run coordinator", () => {
  it("executes compiled tasks with snapshots, evidence, and DONE status", () => {
    const repo = createGitRepository();
    const beforeFiles = listRepositoryFiles(repo);
    const report = runFake({
      repositoryPath: repo,
      planPath: "Plan/RUN.md",
      runId: "run-fake-1",
      now: "2026-08-01T10:00:00Z"
    });

    assert.equal(report.status, "DONE");
    assert.deepEqual(report.executedTasks, ["CONTRACT-01", "BACKEND-01"]);
    assert.ok(report.state.runRoot);
    assert.equal(String(report.state.runRoot).startsWith(repo), false);
    assert.deepEqual(listRepositoryFiles(repo), beforeFiles);

    const contractInput = JSON.parse(readFileSync(join(report.state.runRoot!, "tasks", "CONTRACT-01", "task-input.json"), "utf8"));
    const backendInput = JSON.parse(readFileSync(join(report.state.runRoot!, "tasks", "BACKEND-01", "task-input.json"), "utf8"));
    const evidence = JSON.parse(readFileSync(join(report.state.runRoot!, "tasks", "BACKEND-01", "evidence.json"), "utf8"));
    const backendCommit = JSON.parse(readFileSync(join(report.state.runRoot!, "tasks", "BACKEND-01", "commit.json"), "utf8"));
    const runEvidence = JSON.parse(readFileSync(report.state.runEvidencePath!, "utf8"));
    const review = JSON.parse(readFileSync(join(report.state.runRoot!, "review.json"), "utf8"));
    const runReport = JSON.parse(readFileSync(join(report.state.runRoot!, "run-report.json"), "utf8"));
    const runReportMarkdown = readFileSync(join(report.state.runRoot!, "run-report.md"), "utf8");
    const eventTypes = readFileSync(report.state.eventLogPath!, "utf8")
      .trim()
      .split(/\r?\n/)
      .map((line) => JSON.parse(line) as { type: string });
    const status = runStatus({ repositoryPath: repo, runId: "run-fake-1", now: "2026-08-01T10:01:00Z" });

    assert.deepEqual(contractInput.transitiveDependencies, []);
    assert.equal(backendInput.directDependencies[0].taskId, "CONTRACT-01");
    assert.equal(backendInput.directDependencies[0].commit, report.taskCommits["CONTRACT-01"]);
    assert.match(report.taskCommits["CONTRACT-01"]!, /^[a-f0-9]{40}$/);
    assert.match(report.taskCommits["BACKEND-01"]!, /^[a-f0-9]{40}$/);
    assert.equal(backendCommit.trailers["ai-code-worker-task"], "BACKEND-01");
    assert.ok(eventTypes.some((event) => event.type === "task.worktree-created"));
    assert.ok(eventTypes.some((event) => event.type === "task.committed"));
    assert.ok(eventTypes.some((event) => event.type === "gate.started"));
    assert.ok(eventTypes.some((event) => event.type === "gate.finished"));
    assert.deepEqual(registry.validate("task-input-snapshot.schema.json", backendInput), { valid: true, errors: [] });
    assert.deepEqual(registry.validate("evidence.schema.json", evidence), { valid: true, errors: [] });
    assert.deepEqual(registry.validate("evidence.schema.json", runEvidence), { valid: true, errors: [] });
    assert.deepEqual(registry.validate("review.schema.json", review), { valid: true, errors: [] });
    assert.equal(review.status, "PASS");
    assert.equal(review.coverageMatrix.length, 2);
    assert.equal(runReport.status, "DONE");
    assert.equal(runReport.engine, "fake");
    assert.deepEqual(runReport.taskCommits, report.taskCommits);
    assert.equal(runReport.review.status, "PASS");
    assert.equal(runReport.review.coverageRows, 2);
    assert.equal(runReport.gates.length, 3);
    assert.deepEqual(runReport.usageAssessment, {
      completeness: "partial",
      economicVerdict: "inconclusive",
      unknownFields: ["costUsd"]
    });
    assert.match(runReportMarkdown, /Status: DONE/);
    assert.match(runReportMarkdown, /Economic verdict: inconclusive/);
    assert.match(runReportMarkdown, /CONTRACT-01: [a-f0-9]{40}/);
    assert.equal(evidence.commands.length, 1);
    assert.equal(report.gateResults.length, 3);
    assert.deepEqual(report.usageTotals, {
      agentInvocations: 2,
      inputUncachedTokens: 20,
      cacheReadTokens: 0,
      cacheWriteTokens: 2,
      outputTokens: 10,
      costUsd: null
    });
    assert.equal(runEvidence.input.totalReportedTokens, 22);
    assert.equal(status.run.status, "DONE");
    assert.equal(status.run.taskStates["BACKEND-01"], "FINISHED");
  });

  it("carries v1.1 planner trace identifiers into task evidence", () => {
    const repo = createTraceableGitRepository();
    const report = runFake({
      repositoryPath: repo,
      planPath: "Plan/RUN.md",
      runId: "run-traceable-evidence",
      now: "2026-08-01T10:00:00Z"
    });
    const evidence = JSON.parse(readFileSync(join(report.state.runRoot!, "tasks", "BACKEND-01", "evidence.json"), "utf8"));
    const sourceMap = JSON.parse(readFileSync(join(report.state.runRoot!, "source-map.v1.json"), "utf8"));

    assert.equal(report.status, "DONE");
    assert.equal(evidence.schemaVersion, "1.1");
    assert.deepEqual(evidence.taskTraceability, {
      taskId: "BACKEND-01",
      criterionIds: ["BACKEND-01-AC-01"],
      gates: [{
        gateId: "BACKEND-01-G-01",
        criterionIds: ["BACKEND-01-AC-01"],
        evidenceContract: "The command exits with code zero.",
        commandId: 'node -e "process.exit(0)"'
      }]
    });
    assert.deepEqual(registry.validate("evidence.schema.json", evidence), { valid: true, errors: [] });
    assert.deepEqual(registry.validate("source-map.schema.json", sourceMap), { valid: true, errors: [] });
    assert.equal(sourceMap.coverage.complete, true);
    assert.equal(sourceMap.coverage.traceCoveragePercent, 100);
    assert.equal(sourceMap.findings.length, 0);
  });

  it("blocks the run when aggregate usage exceeds manifest budgets", () => {
    const repo = createGitRepository({
      maximumRunInputUncachedTokens: 15
    });
    const report = runFake({
      repositoryPath: repo,
      planPath: "Plan/RUN.md",
      runId: "run-budget-block",
      now: "2026-08-01T10:00:00Z"
    });
    const status = runStatus({ repositoryPath: repo, runId: "run-budget-block", now: "2026-08-01T10:01:00Z" });
    const runReport = JSON.parse(readFileSync(join(report.state.runRoot!, "run-report.json"), "utf8"));

    assert.equal(report.status, "BLOCKED");
    assert.equal(report.findings[0]?.code, "USAGE_BUDGET_EXCEEDED");
    assert.equal(report.executedTasks.length, 2);
    assert.equal(runReport.status, "BLOCKED");
    assert.equal(runReport.blockedReason, "inputUncachedTokens 20 exceeds maximum 15.");
    assert.ok(existsSync(join(report.state.runRoot!, "run-report.md")));
    assert.equal(status.run.status, "BLOCKED");
    assert.equal(status.run.blockedReason, "inputUncachedTokens 20 exceeds maximum 15.");
  });

  it("blocks the run when a real task gate fails", () => {
    const repo = createGitRepository(
      {},
      {
        taskVerify: ['node -e "process.exit(7)"'],
        globalGates: ['node -e "process.exit(0)"']
      }
    );
    const report = runFake({
      repositoryPath: repo,
      planPath: "Plan/RUN.md",
      runId: "run-gate-block",
      now: "2026-08-01T10:00:00Z"
    });
    const status = runStatus({ repositoryPath: repo, runId: "run-gate-block", now: "2026-08-01T10:01:00Z" });

    assert.equal(report.status, "BLOCKED");
    assert.equal(report.findings[0]?.code, "TASK_GATE_FAILED");
    assert.equal(report.gateResults[0]?.exitCode, 7);
    assert.equal(status.run.status, "BLOCKED");
    assert.match(status.run.blockedReason!, /task:CONTRACT-01 gate/);
  });

  it("blocks DONE when read-only review cannot cover an acceptance criterion", () => {
    const repo = createGitRepository(
      {},
      {
        taskVerify: [],
        globalGates: ['node -e "process.exit(0)"']
      }
    );
    const report = runFake({
      repositoryPath: repo,
      planPath: "Plan/RUN.md",
      runId: "run-review-block",
      now: "2026-08-01T10:00:00Z"
    });
    const review = JSON.parse(readFileSync(join(report.state.runRoot!, "review.json"), "utf8"));
    const runReport = JSON.parse(readFileSync(join(report.state.runRoot!, "run-report.json"), "utf8"));

    assert.equal(report.status, "BLOCKED");
    assert.equal(report.findings[0]?.code, "REVIEW_FAILED");
    assert.equal(review.status, "FAIL");
    assert.equal(runReport.status, "BLOCKED");
    assert.equal(runReport.review.status, "FAIL");
    assert.match(report.findings[0]?.message ?? "", /no verification command/);
  });

  it("returns DONE idempotently when the run already completed", () => {
    const repo = createGitRepository();
    const first = runFake({ repositoryPath: repo, planPath: "Plan/RUN.md", runId: "run-fake-2", now: "2026-08-01T10:00:00Z" });
    const beforeEvents = readFileSync(first.state.eventLogPath!, "utf8");
    const second = runFake({
      repositoryPath: repo,
      planPath: "Plan/RUN.md",
      runId: "run-fake-2",
      now: "2026-08-01T10:10:00Z"
    });
    const afterEvents = readFileSync(first.state.eventLogPath!, "utf8");

    assert.equal(first.status, "DONE");
    assert.equal(second.status, "DONE");
    assert.deepEqual(second.taskCommits, first.taskCommits);
    assert.equal(afterEvents, beforeEvents);
  });

  it("resumes after a crash following task commit without creating a duplicate commit", () => {
    const repo = createGitRepository();
    const first = runFake({
      repositoryPath: repo,
      planPath: "Plan/RUN.md",
      runId: "run-crash-after-commit",
      now: "2026-08-01T10:00:00Z"
    });
    const events = readFileSync(first.state.eventLogPath!, "utf8")
      .trim()
      .split(/\r?\n/)
      .map((line) => JSON.parse(line) as { type: string; payload: Record<string, unknown> });
    const committedIndex = events.findIndex(
      (event) => event.type === "task.committed" && event.payload.taskId === "CONTRACT-01"
    );

    assert.ok(committedIndex > 0);
    writeFileSync(
      first.state.eventLogPath!,
      `${events
        .slice(0, committedIndex + 1)
        .map((event) => JSON.stringify(event))
        .join("\n")}\n`,
      "utf8"
    );
    execFileSync("git", ["worktree", "remove", "--force", join(dirname(dirname(first.state.runRoot!)), "worktrees", "run-crash-after-commit", "BACKEND-01", "attempt-1")], {
      cwd: repo,
      stdio: "ignore"
    });

    const recovered = runFake({
      repositoryPath: repo,
      planPath: "Plan/RUN.md",
      runId: "run-crash-after-commit",
      now: "2026-08-01T10:05:00Z"
    });
    const recoveredEvents = readFileSync(recovered.state.eventLogPath!, "utf8")
      .trim()
      .split(/\r?\n/)
      .map((line) => JSON.parse(line) as { type: string; payload: Record<string, unknown> });
    const contractCommitEvents = recoveredEvents.filter(
      (event) => event.type === "task.committed" && event.payload.taskId === "CONTRACT-01"
    );

    assert.equal(recovered.status, "DONE");
    assert.equal(recovered.taskCommits["CONTRACT-01"], first.taskCommits["CONTRACT-01"]);
    assert.equal(contractCommitEvents.length, 1);
    assert.ok(recoveredEvents.some((event) => event.type === "task.finished" && event.payload.taskId === "CONTRACT-01"));
  });

  it("exposes run --engine fake as a JSON CLI command", () => {
    const repo = createGitRepository();
    const output = execFileSync(
      process.execPath,
      [resolve("dist/src/cli.js"), "run", "--engine", "fake", "--repo", repo, "--plan", "Plan/RUN.md", "--run-id", "run-cli-fake", "--json"],
      { cwd: tmpdir(), encoding: "utf8" }
    );
    const report = JSON.parse(output) as { status: string; executedTasks: string[] };

    assert.equal(report.status, "DONE");
    assert.deepEqual(report.executedTasks, ["CONTRACT-01", "BACKEND-01"]);
  });

  it("omits contextProvider from the JSON report when no project config opts in (stage 1/2 exit criterion)", () => {
    const repo = createGitRepository();
    const output = execFileSync(
      process.execPath,
      [resolve("dist/src/cli.js"), "run", "--engine", "fake", "--repo", repo, "--plan", "Plan/RUN.md", "--run-id", "run-cli-fake-no-provider", "--json"],
      { cwd: tmpdir(), encoding: "utf8" }
    );
    const report = JSON.parse(output) as Record<string, unknown>;

    assert.equal(report.status, "DONE");
    assert.equal("contextProvider" in report, false);
  });

  it("includes an UNAVAILABLE contextProvider summary when configured but the executable is missing", () => {
    const repo = createGitRepository();
    mkdirSync(join(repo, ".ai-code-worker"), { recursive: true });
    writeFileSync(
      join(repo, ".ai-code-worker", "config.json"),
      JSON.stringify({
        contextProvider: "ai-code-control",
        adapters: { aiCodeControl: { executable: "this-binary-does-not-exist-aicw" } }
      }),
      "utf8"
    );

    const output = execFileSync(
      process.execPath,
      [resolve("dist/src/cli.js"), "run", "--engine", "fake", "--repo", repo, "--plan", "Plan/RUN.md", "--run-id", "run-cli-fake-provider", "--json"],
      { cwd: tmpdir(), encoding: "utf8" }
    );
    const report = JSON.parse(output) as {
      status: string;
      contextProvider?: { kind: string; health: { status: string }; brief: { status: string }; refresh: { status: string } | null };
    };

    assert.equal(report.status, "DONE");
    assert.equal(report.contextProvider?.kind, "ai-code-control");
    assert.equal(report.contextProvider?.health.status, "UNAVAILABLE");
    assert.equal(report.contextProvider?.brief.status, "UNAVAILABLE");
    assert.equal(report.contextProvider?.refresh?.status, "UNAVAILABLE");
  });

  it("observe mode exports compilation outcomes without changing fake-run execution", () => {
    const repo = createGitRepository();
    mkdirSync(join(repo, ".ai-code-worker"), { recursive: true });
    writeFileSync(
      join(repo, ".ai-code-worker", "config.json"),
      JSON.stringify({
        contextProvider: "ai-code-control",
        contextPackage: { mode: "observe", maximumTokens: 2000 },
        adapters: { aiCodeControl: { executable: "this-binary-does-not-exist-aicw" } }
      }),
      "utf8"
    );

    const output = execFileSync(
      process.execPath,
      [resolve("dist/src/cli.js"), "run", "--engine", "fake", "--repo", repo, "--plan", "Plan/RUN.md", "--run-id", "run-context-observe", "--json"],
      { cwd: tmpdir(), encoding: "utf8" }
    );
    const report = JSON.parse(output) as {
      status: string;
      state: { runRoot: string };
      contextPackages: { mode: string; packages: readonly { taskId: string; status: string }[] };
    };

    assert.equal(report.status, "DONE");
    assert.equal(report.contextPackages.mode, "observe");
    assert.deepEqual(report.contextPackages.packages.map((entry) => entry.status), ["UNAVAILABLE", "UNAVAILABLE"]);
    assert.equal(existsSync(join(report.state.runRoot, "context-package-index.v1.json")), true);
    const snapshot = JSON.parse(
      readFileSync(join(report.state.runRoot, "tasks", "CONTRACT-01", "task-input.json"), "utf8")
    ) as Record<string, unknown>;
    assert.equal(snapshot.schemaVersion, "1.1");
    assert.equal(snapshot.contextDigest, null);
    assert.match(String(snapshot.qualityGateConfigHash), /^[a-f0-9]{64}$/);
    assert.match(String(snapshot.policyHash), /^[a-f0-9]{64}$/);
    assert.match(String(snapshot.toolchainConfigHash), /^[a-f0-9]{64}$/);
  });

  it("enforce mode fails closed before execution when the selected engine cannot consume packages", () => {
    const repo = createGitRepository();
    mkdirSync(join(repo, ".ai-code-worker"), { recursive: true });
    writeFileSync(
      join(repo, ".ai-code-worker", "config.json"),
      JSON.stringify({
        contextProvider: "ai-code-control",
        contextPackage: { mode: "enforce", maximumTokens: 2000 },
        adapters: { aiCodeControl: { executable: "this-binary-does-not-exist-aicw" } }
      }),
      "utf8"
    );

    let output = "";
    try {
      output = execFileSync(
        process.execPath,
        [resolve("dist/src/cli.js"), "run", "--engine", "fake", "--repo", repo, "--plan", "Plan/RUN.md", "--run-id", "run-context-enforce", "--json"],
        { cwd: tmpdir(), encoding: "utf8" }
      );
    } catch (error) {
      output = (error as { readonly stdout?: string }).stdout ?? "";
    }
    const report = JSON.parse(output) as {
      status: string;
      executedTasks: readonly string[];
      findings: readonly { code: string }[];
    };

    assert.equal(report.status, "BLOCKED");
    assert.deepEqual(report.executedTasks, []);
    assert.equal(report.findings[0]?.code, "CONTEXT_PACKAGE_ENFORCEMENT_FAILED");
  });

  it("omits contextProvider.symbols when no task declares relevantSymbols", () => {
    const repo = createGitRepository();
    mkdirSync(join(repo, ".ai-code-worker"), { recursive: true });
    writeFileSync(
      join(repo, ".ai-code-worker", "config.json"),
      JSON.stringify({
        contextProvider: "ai-code-control",
        adapters: { aiCodeControl: { executable: "this-binary-does-not-exist-aicw" } }
      }),
      "utf8"
    );

    const output = execFileSync(
      process.execPath,
      [resolve("dist/src/cli.js"), "run", "--engine", "fake", "--repo", repo, "--plan", "Plan/RUN.md", "--run-id", "run-cli-no-symbols", "--json"],
      { cwd: tmpdir(), encoding: "utf8" }
    );
    const report = JSON.parse(output) as { contextProvider?: { symbols?: unknown } };

    assert.equal(report.contextProvider?.symbols, undefined);
  });

  it("looks up each task's declared relevantSymbols via find-symbol and impact", () => {
    const repo = createGitRepositoryWithRelevantSymbols(["InvoiceTotal", "BillingModule"]);
    mkdirSync(join(repo, ".ai-code-worker"), { recursive: true });
    writeFileSync(
      join(repo, ".ai-code-worker", "config.json"),
      JSON.stringify({
        contextProvider: "ai-code-control",
        adapters: { aiCodeControl: { executable: "this-binary-does-not-exist-aicw" } }
      }),
      "utf8"
    );

    const output = execFileSync(
      process.execPath,
      [resolve("dist/src/cli.js"), "run", "--engine", "fake", "--repo", repo, "--plan", "Plan/RUN.md", "--run-id", "run-cli-symbols", "--json"],
      { cwd: tmpdir(), encoding: "utf8" }
    );
    const report = JSON.parse(output) as {
      contextProvider?: { symbols?: readonly { symbol: string; findSymbol: { status: string }; impact: { status: string } }[] };
    };

    assert.deepEqual(
      report.contextProvider?.symbols?.map((entry) => entry.symbol),
      ["BillingModule", "InvoiceTotal"]
    );
    for (const entry of report.contextProvider?.symbols ?? []) {
      assert.equal(entry.findSymbol.status, "UNAVAILABLE");
      assert.equal(entry.impact.status, "UNAVAILABLE");
    }
  });

  it("does not export a handoff when contextProvider is active but handoffExport is not opted in", () => {
    const repo = createGitRepository();
    mkdirSync(join(repo, ".ai-code-worker"), { recursive: true });
    writeFileSync(
      join(repo, ".ai-code-worker", "config.json"),
      JSON.stringify({ contextProvider: "ai-code-control" }),
      "utf8"
    );

    const output = execFileSync(
      process.execPath,
      [resolve("dist/src/cli.js"), "run", "--engine", "fake", "--repo", repo, "--plan", "Plan/RUN.md", "--run-id", "run-cli-no-handoff", "--json"],
      { cwd: tmpdir(), encoding: "utf8" }
    );
    const report = JSON.parse(output) as Record<string, unknown>;

    assert.equal("handoffExport" in report, false);
    assert.equal(existsSync(join(repo, ".ai-code-control", "handoffs", "run-cli-no-handoff.md")), false);
  });

  it("exports a redacted handoff to .ai-code-control/handoffs/ when opted in", () => {
    const repo = createGitRepository();
    mkdirSync(join(repo, ".ai-code-worker"), { recursive: true });
    writeFileSync(
      join(repo, ".ai-code-worker", "config.json"),
      JSON.stringify({ contextProvider: "ai-code-control", handoffExport: true }),
      "utf8"
    );

    const output = execFileSync(
      process.execPath,
      [resolve("dist/src/cli.js"), "run", "--engine", "fake", "--repo", repo, "--plan", "Plan/RUN.md", "--run-id", "run-cli-handoff", "--json"],
      { cwd: tmpdir(), encoding: "utf8" }
    );
    const report = JSON.parse(output) as { handoffExport?: { path: string } };

    assert.ok(report.handoffExport?.path);
    assert.equal(existsSync(join(repo, ".ai-code-control", "handoffs", "run-cli-handoff.md")), true);
  });
});

function createGitRepository(budgetOverrides: Record<string, unknown> = {}, gateOverrides: GateOverrides = {}): string {
  const repo = mkdtempSync(join(tmpdir(), "aicw-fake-run-"));
  tempRepos.push(repo);
  stateRoots.push(resolveStateRoot({ repoRoot: repo }).path);

  mkdirSync(join(repo, "Plan"), { recursive: true });
  writeFileSync(join(repo, "README.md"), "# fixture\n", "utf8");
  writeFileSync(join(repo, "Plan", "RUN.md"), acceptedPlan(budgetOverrides, gateOverrides), "utf8");
  execFileSync("git", ["init"], { cwd: repo, stdio: "ignore" });
  execFileSync("git", ["add", "README.md", "Plan/RUN.md"], { cwd: repo, stdio: "ignore" });
  execFileSync("git", ["-c", "user.name=ai-code-worker", "-c", "user.email=worker@example.test", "commit", "-m", "fake run fixture"], {
    cwd: repo,
    env: {
      ...process.env,
      GIT_AUTHOR_DATE: "2026-08-01T10:00:00Z",
      GIT_COMMITTER_DATE: "2026-08-01T10:00:00Z"
    },
    stdio: "ignore"
  });

  return repo;
}

function createTraceableGitRepository(): string {
  const repo = createGitRepository();
  const body = planBody({}, {}) as {
    workerContractVersion?: "1.1";
    tasks: Array<Record<string, unknown>>;
  };
  body.workerContractVersion = "1.1";
  body.tasks = body.tasks.map((task) => {
    const taskId = String(task.id);
    const criterionId = `${taskId}-AC-01`;
    const command = (task.verify as string[])[0]!;
    return {
      ...task,
      traceability: {
        acceptanceCriteria: [{ criterionId, text: (task.acceptanceCriteria as string[])[0]! }],
        gates: [{
          gateId: `${taskId}-G-01`,
          command,
          evidenceContract: "The command exits with code zero.",
          criterionIds: [criterionId]
        }]
      }
    };
  });
  writeFileSync(join(repo, "Plan", "RUN.md"), `---
status: accepted
---

# Traceable fake run plan

\`\`\`json ai-code-worker-plan
${JSON.stringify(body, null, 2)}
\`\`\`
`, "utf8");
  execFileSync("git", ["add", "Plan/RUN.md"], { cwd: repo, stdio: "ignore" });
  execFileSync(
    "git",
    ["-c", "user.name=ai-code-worker", "-c", "user.email=worker@example.test", "commit", "--amend", "--no-edit"],
    { cwd: repo, stdio: "ignore" }
  );
  return repo;
}

function createGitRepositoryWithRelevantSymbols(relevantSymbols: readonly string[]): string {
  const repo = mkdtempSync(join(tmpdir(), "aicw-fake-run-symbols-"));
  tempRepos.push(repo);
  stateRoots.push(resolveStateRoot({ repoRoot: repo }).path);

  mkdirSync(join(repo, "Plan"), { recursive: true });
  writeFileSync(join(repo, "README.md"), "# fixture\n", "utf8");
  writeFileSync(
    join(repo, "Plan", "RUN.md"),
    `---
status: accepted
---

# Fake run plan with relevantSymbols

\`\`\`json ai-code-worker-plan
${JSON.stringify(
  {
    goal: "Execute a deterministic fake task flow whose task declares relevantSymbols.",
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
        acceptanceCriteria: ["Contract task compiles."],
        verify: ['node -e "process.exit(0)"'],
        concurrencyKeys: ["fake-run"],
        risk: "low",
        relevantSymbols
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
  execFileSync("git", ["init"], { cwd: repo, stdio: "ignore" });
  execFileSync("git", ["add", "README.md", "Plan/RUN.md"], { cwd: repo, stdio: "ignore" });
  execFileSync(
    "git",
    ["-c", "user.name=ai-code-worker", "-c", "user.email=worker@example.test", "commit", "-m", "fake run fixture with relevantSymbols"],
    {
      cwd: repo,
      env: { ...process.env, GIT_AUTHOR_DATE: "2026-08-01T10:00:00Z", GIT_COMMITTER_DATE: "2026-08-01T10:00:00Z" },
      stdio: "ignore"
    }
  );

  return repo;
}

interface GateOverrides {
  readonly taskVerify?: readonly string[];
  readonly globalGates?: readonly string[];
}

function acceptedPlan(budgetOverrides: Record<string, unknown>, gateOverrides: GateOverrides): string {
  return `---
status: accepted
---

# Fake run plan

\`\`\`json ai-code-worker-plan
${JSON.stringify(planBody(budgetOverrides, gateOverrides), null, 2)}
\`\`\`
`;
}

function planBody(budgetOverrides: Record<string, unknown>, gateOverrides: GateOverrides): unknown {
  const taskVerify = gateOverrides.taskVerify ?? ['node -e "process.exit(0)"'];

  return {
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
        expectedArtifacts: ["dist/src/cli.js"],
        acceptanceCriteria: ["Contract task receives an empty dependency snapshot."],
        verify: taskVerify,
        concurrencyKeys: ["fake-run"],
        risk: "low"
      },
      {
        id: "BACKEND-01",
        kind: "backend",
        role: "phase0-worker",
        dependsOn: ["CONTRACT-01"],
        requiredInputs: ["README.md"],
        allowedPaths: ["src/**"],
        forbiddenPaths: [".git/**"],
        expectedArtifacts: ["dist/src/cli.js"],
        acceptanceCriteria: ["Backend task sees the contract dependency commit."],
        verify: taskVerify,
        concurrencyKeys: ["fake-run"],
        risk: "low"
      }
    ],
    globalGates: gateOverrides.globalGates ?? ['node -e "process.exit(0)"'],
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
      onUnknownUsage: "block",
      ...budgetOverrides
    }
  };
}

function listRepositoryFiles(repo: string): string[] {
  return readdirSync(repo, { recursive: true })
    .map((entry) => String(entry).replaceAll("\\", "/"))
    .filter((entry) => !entry.startsWith(".git/") && entry !== ".git")
    .sort();
}
