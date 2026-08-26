import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { after, describe, it } from "node:test";
import { writeFakeCodexCli } from "../../src/engines/codex-cli.js";
import { runCodex } from "../../src/run/codex-run.js";
import { SchemaRegistry } from "../../src/schema/json-schema.js";
import { resolveStateRoot } from "../../src/state/state-root.js";

const tempRepos: string[] = [];
const stateRoots: string[] = [];
const tempRoots: string[] = [];
const registry = SchemaRegistry.load({ schemaDirectory: "schemas" });

after(() => {
  for (const root of stateRoots) {
    rmSync(root, { recursive: true, force: true });
  }

  for (const root of tempRoots) {
    rmSync(root, { recursive: true, force: true });
  }

  for (const repo of tempRepos) {
    rmSync(repo, { recursive: true, force: true });
  }
});

describe("codex run coordinator", () => {
  it("executes a single-writer codex run through worktree, commit, gates, review, and report", () => {
    const repo = createGitRepository();
    const beforeFiles = listRepositoryFiles(repo);
    const cli = fakeCli("0.146.0-alpha.3.1", "src/codex-output.txt");
    const report = runCodex({
      repositoryPath: repo,
      planPath: "Plan/RUN.md",
      runId: "run-codex",
      now: "2026-08-01T10:00:00Z",
      trustedLocalAuthorization: trustedLocalAuthorization(),
      adapterConfig: {
        executable: process.execPath,
        baseArgs: [cli],
        testedVersionRanges: ["0.146.0-alpha.3.1"],
        requiresCapabilitySmokeTest: true
      }
    });

    assert.equal(report.status, "DONE");
    assert.deepEqual(report.executedTasks, ["TASK-01"]);
    assert.match(report.taskCommits["TASK-01"]!, /^[a-f0-9]{40}$/);
    assert.deepEqual(listRepositoryFiles(repo), beforeFiles);

    const taskRoot = join(report.state.runRoot!, "tasks", "TASK-01");
    const agentResult = JSON.parse(readFileSync(join(taskRoot, "agent-result.json"), "utf8"));
    const evidence = JSON.parse(readFileSync(join(taskRoot, "evidence.json"), "utf8"));
    const runEvidence = JSON.parse(readFileSync(report.state.runEvidencePath!, "utf8"));
    const runReport = JSON.parse(readFileSync(join(report.state.runRoot!, "run-report.json"), "utf8"));

    assert.equal(agentResult.runId, "run-codex");
    assert.equal(agentResult.taskId, "TASK-01");
    assert.deepEqual(registry.validate("agent-result.schema.json", agentResult), { valid: true, errors: [] });
    assert.deepEqual(registry.validate("evidence.schema.json", evidence), { valid: true, errors: [] });
    assert.deepEqual(registry.validate("evidence.schema.json", runEvidence), { valid: true, errors: [] });
    assert.equal(runReport.status, "DONE");
    assert.equal(runReport.engine, "codex");
    assert.equal(runReport.sandbox.mode, "workspace-write");
    assert.equal(runReport.sandbox.status, "RESTRICTED");
    assert.equal(runReport.sandbox.authorization, null);
    assert.equal(runReport.executionEnvironment.capabilityReport.backend, "trusted-local");
    assert.equal(runReport.executionEnvironment.capabilityReport.securityBoundary, "host-process");
    assert.equal(runReport.executionEnvironment.trustedLocalAuthorization.authorizedBy, "external-test-controller");
    assert.ok(runReport.executionEnvironment.capabilityReport.warnings.some((warning: string) => /not a host security sandbox/i.test(warning)));
    assert.match(runReport.artifacts.sandboxPolicyPath, /sandbox-policy\.json$/);
    assert.equal(runReport.review.status, "PASS");
    assert.deepEqual(runReport.taskCommits, report.taskCommits);
  });

  it("scrubs non-allowlisted host variables from the actual writer process", () => {
    const repo = createGitRepository();
    const secretName = "INFOAPEX_AI_TEST_HOST_SECRET";
    const previous = process.env[secretName];
    const cli = fakeCli("0.146.0-alpha.3.1", "src/codex-output.txt", secretName);
    process.env[secretName] = "must-not-reach-writer";

    try {
      assert.throws(() =>
        execFileSync(process.execPath, [cli, "exec"], {
          input: JSON.stringify({ runId: "unbound-control", taskId: "TASK-01" }),
          env: process.env,
          stdio: ["pipe", "pipe", "pipe"]
        })
      );

      const report = runCodex({
        repositoryPath: repo,
        planPath: "Plan/RUN.md",
        runId: "run-codex-scrubbed-environment",
        now: "2026-08-01T10:00:00Z",
        trustedLocalAuthorization: trustedLocalAuthorization(),
        adapterConfig: {
          executable: process.execPath,
          baseArgs: [cli],
          testedVersionRanges: ["0.146.0-alpha.3.1"],
          requiresCapabilitySmokeTest: true
        }
      });

      assert.equal(report.status, "DONE");
    } finally {
      if (previous === undefined) delete process.env[secretName];
      else process.env[secretName] = previous;
    }
  });

  it("honors testedVersionRanges from .ai-code-worker/config.json (previously dead config)", () => {
    const repo = createGitRepository();
    mkdirSync(join(repo, ".ai-code-worker"), { recursive: true });
    writeFileSync(
      join(repo, ".ai-code-worker", "config.json"),
      JSON.stringify(trustedLocalProjectConfig({ testedVersionRanges: ["9.9.9-project-configured"] })),
      "utf8"
    );
    const cli = fakeCli("9.9.9-project-configured", "src/codex-output.txt");

    const report = runCodex({
      repositoryPath: repo,
      planPath: "Plan/RUN.md",
      runId: "run-codex-project-config",
      now: "2026-08-01T10:00:00Z",
      trustedLocalAuthorization: trustedLocalAuthorization(),
      adapterConfig: {
        executable: process.execPath,
        baseArgs: [cli],
        requiresCapabilitySmokeTest: true
        // deliberately no testedVersionRanges here - only the project config supplies it
      }
    });

    assert.equal(report.status, "DONE");
  });

  it("blocks a programmatic danger-full-access override without approval and records the decision", () => {
    const repo = createGitRepository();
    const cli = fakeCli("0.146.0-alpha.3.1", "src/codex-output.txt");
    const report = runCodex({
      repositoryPath: repo,
      planPath: "Plan/RUN.md",
      runId: "run-codex-unauthorized-danger",
      now: "2026-08-26T09:00:00Z",
      trustedLocalAuthorization: trustedLocalAuthorization(),
      adapterConfig: {
        executable: process.execPath,
        baseArgs: [cli],
        testedVersionRanges: ["0.146.0-alpha.3.1"],
        requiresCapabilitySmokeTest: true,
        sandboxMode: "danger-full-access"
      }
    });

    assert.equal(report.status, "BLOCKED");
    assert.equal(report.findings[0]?.code, "CODEX_DANGER_FULL_ACCESS_UNAUTHORIZED");
    const runReport = JSON.parse(readFileSync(join(report.state.runRoot!, "run-report.json"), "utf8"));
    assert.equal(runReport.sandbox.mode, "danger-full-access");
    assert.equal(runReport.sandbox.status, "BLOCKED");
    assert.equal(runReport.sandbox.authorization, null);
  });

  it("accepts an explicitly approved API elevation and records immutable provenance", () => {
    const repo = createGitRepository();
    const cli = fakeCli("0.146.0-alpha.3.1", "src/codex-output.txt");
    const report = runCodex({
      repositoryPath: repo,
      planPath: "Plan/RUN.md",
      runId: "run-codex-api-approved-danger",
      now: "2026-08-26T09:00:00Z",
      trustedLocalAuthorization: trustedLocalAuthorization(),
      adapterConfig: {
        executable: process.execPath,
        baseArgs: [cli],
        testedVersionRanges: ["0.146.0-alpha.3.1"],
        requiresCapabilitySmokeTest: true,
        sandboxMode: "danger-full-access",
        dangerFullAccessApproval: {
          approved: true,
          authorizedBy: "external-controller",
          reason: "Explicit disposable-worktree compatibility run",
          approvedAt: "2026-08-26T09:00:00.000Z",
          source: "api"
        }
      }
    });

    assert.equal(report.status, "DONE");
    const runReport = JSON.parse(readFileSync(join(report.state.runRoot!, "run-report.json"), "utf8"));
    assert.equal(runReport.sandbox.status, "AUTHORIZED");
    assert.equal(runReport.sandbox.authorization.authorizedBy, "external-controller");
    assert.equal(runReport.sandbox.authorization.source, "api");
    const engineEvents = JSON.parse(
      readFileSync(join(report.state.runRoot!, "tasks", "TASK-01", "engine-events.json"), "utf8")
    );
    assert.equal(engineEvents[0].payload.sandbox.authorization.authorizedBy, "external-controller");
    assert.equal(engineEvents[0].payload.executionEnvironment.backend, "trusted-local");
    assert.equal(engineEvents[0].payload.executionEnvironment.securityBoundary, "host-process");
  });

  it("keeps danger authorization write-once across terminal recovery", () => {
    const repo = createGitRepository();
    const cli = fakeCli("0.146.0-alpha.3.1", "src/codex-output.txt");
    const approval = {
      approved: true as const,
      authorizedBy: "external-controller",
      reason: "Explicit immutable recovery test",
      approvedAt: "2026-08-26T09:00:00.000Z",
      source: "api" as const
    };
    const options = {
      repositoryPath: repo,
      planPath: "Plan/RUN.md",
      runId: "run-codex-danger-recovery",
      now: "2026-08-26T09:00:00Z",
      trustedLocalAuthorization: trustedLocalAuthorization(),
      adapterConfig: {
        executable: process.execPath,
        baseArgs: [cli],
        testedVersionRanges: ["0.146.0-alpha.3.1"],
        requiresCapabilitySmokeTest: true,
        sandboxMode: "danger-full-access" as const,
        dangerFullAccessApproval: approval
      }
    };

    const first = runCodex(options);
    assert.equal(first.status, "DONE");
    const policyPath = join(first.state.runRoot!, "sandbox-policy.json");
    const frozenPolicy = readFileSync(policyPath, "utf8");

    const sameGrantRecovery = runCodex(options);
    assert.equal(sameGrantRecovery.status, "DONE");

    const changedGrantRecovery = runCodex({
      ...options,
      adapterConfig: {
        ...options.adapterConfig,
        dangerFullAccessApproval: { ...approval, approvedAt: "2026-08-26T09:00:01.000Z" }
      }
    });
    assert.equal(changedGrantRecovery.status, "BLOCKED");
    assert.equal(changedGrantRecovery.findings[0]?.code, "CODEX_SANDBOX_POLICY_CONFLICT");
    assert.equal(readFileSync(policyPath, "utf8"), frozenPolicy);
  });

  it("keeps trusted-local authorization write-once across recovery", () => {
    const repo = createGitRepository();
    const cli = fakeCli("0.146.0-alpha.3.1", "src/codex-output.txt");
    const options = {
      repositoryPath: repo,
      planPath: "Plan/RUN.md",
      runId: "run-codex-trusted-recovery",
      now: "2026-08-26T09:00:00Z",
      trustedLocalAuthorization: trustedLocalAuthorization(),
      adapterConfig: {
        executable: process.execPath,
        baseArgs: [cli],
        testedVersionRanges: ["0.146.0-alpha.3.1"],
        requiresCapabilitySmokeTest: true
      }
    };

    const first = runCodex(options);
    assert.equal(first.status, "DONE");
    const authorizationPath = first.compile.state.authorizationPath!;
    const frozenAuthorization = readFileSync(authorizationPath, "utf8");

    const changedGrantRecovery = runCodex({
      ...options,
      trustedLocalAuthorization: {
        ...trustedLocalAuthorization(),
        approvedAt: "2026-08-26T09:00:01.000Z"
      }
    });
    assert.equal(changedGrantRecovery.status, "BLOCKED");
    assert.equal(changedGrantRecovery.compile.findings[0]?.code, "RUN_STATE_CONFLICT");
    assert.equal(readFileSync(authorizationPath, "utf8"), frozenAuthorization);
  });

  it("does not trust a repository config to approve its own danger-full-access request", () => {
    const repo = createGitRepository();
    mkdirSync(join(repo, ".ai-code-worker"), { recursive: true });
    writeFileSync(
      join(repo, ".ai-code-worker", "config.json"),
      JSON.stringify(trustedLocalProjectConfig({
        sandboxMode: "danger-full-access",
        // A repository-controlled lookalike approval is intentionally ignored.
        dangerFullAccessApproval: {
          approved: true,
          authorizedBy: "project-owner",
          reason: "Repository content cannot grant host privileges",
          approvedAt: "2026-08-26T09:00:00.000Z"
        }
      })),
      "utf8"
    );
    const cli = fakeCli("0.146.0-alpha.3.1", "src/codex-output.txt");
    const report = runCodex({
      repositoryPath: repo,
      planPath: "Plan/RUN.md",
      runId: "run-codex-config-approved-danger",
      now: "2026-08-26T09:00:00Z",
      trustedLocalAuthorization: trustedLocalAuthorization(),
      adapterConfig: {
        executable: process.execPath,
        baseArgs: [cli],
        testedVersionRanges: ["0.146.0-alpha.3.1"],
        requiresCapabilitySmokeTest: true
      }
    });

    assert.equal(report.status, "BLOCKED");
    assert.equal(report.findings[0]?.code, "CODEX_DANGER_FULL_ACCESS_UNAUTHORIZED");
    const runReport = JSON.parse(readFileSync(join(report.state.runRoot!, "run-report.json"), "utf8"));
    assert.equal(runReport.sandbox.status, "BLOCKED");
    assert.equal(runReport.sandbox.authorization, null);
  });
});

function createGitRepository(): string {
  const repo = mkdtempSync(join(tmpdir(), "aicw-codex-run-"));
  tempRepos.push(repo);
  stateRoots.push(resolveStateRoot({ repoRoot: repo }).path);

  mkdirSync(join(repo, "Plan"), { recursive: true });
  mkdirSync(join(repo, ".ai-code-worker"), { recursive: true });
  writeFileSync(join(repo, "README.md"), "# fixture\n", "utf8");
  writeFileSync(join(repo, "Plan", "RUN.md"), acceptedPlan(), "utf8");
  writeFileSync(
    join(repo, ".ai-code-worker", "config.json"),
    JSON.stringify(trustedLocalProjectConfig()),
    "utf8"
  );
  writeFileSync(
    join(repo, ".ai-code-worker", "execution-environment.example.json"),
    readFileSync("templates/project/.ai-code-worker/execution-environment.trusted-local.example.json", "utf8"),
    "utf8"
  );
  execFileSync("git", ["init"], { cwd: repo, stdio: "ignore" });
  execFileSync("git", ["add", "."], { cwd: repo, stdio: "ignore" });
  execFileSync("git", ["-c", "user.name=ai-code-worker", "-c", "user.email=worker@example.test", "commit", "-m", "codex run fixture"], {
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

function trustedLocalProjectConfig(codex: Record<string, unknown> = {}): unknown {
  return {
    schemaVersion: "1.0",
    executionEnvironment: { defaultProfile: "trusted-local", allowTrustedLocal: true },
    adapters: { codex }
  };
}

function trustedLocalAuthorization() {
  return {
    approved: true as const,
    authorizedBy: "external-test-controller",
    reason: "Explicit trusted-local test execution",
    approvedAt: "2026-08-26T09:00:00.000Z",
    source: "api" as const
  };
}

function fakeCli(version: string, touchedFile: string, failTaskIfEnvironmentVariablePresent?: string): string {
  const root = mkdtempSync(join(tmpdir(), "aicw-fake-codex-run-"));
  tempRoots.push(root);
  const cli = join(root, "codex-fake.mjs");
  writeFakeCodexCli(cli, { version, touchedFile, failTaskIfEnvironmentVariablePresent });
  chmodSync(cli, 0o755);
  return cli;
}

function acceptedPlan(): string {
  return `---
status: accepted
---

# Codex run plan

\`\`\`json ai-code-worker-plan
${JSON.stringify(planBody(), null, 2)}
\`\`\`
`;
}

function planBody(): unknown {
  return {
    goal: "Execute a Codex-backed single-writer task.",
    tasks: [
      {
        id: "TASK-01",
        kind: "backend",
        role: "phase1-codex-worker",
        dependsOn: [],
        requiredInputs: ["README.md"],
        allowedPaths: ["src/**"],
        forbiddenPaths: [".git/**"],
        expectedArtifacts: ["src/codex-output.txt"],
        acceptanceCriteria: ["Codex writes the expected output file."],
        verify: ['node -e "process.exit(require(\'fs\').existsSync(\'src/codex-output.txt\') ? 0 : 1)"'],
        concurrencyKeys: ["codex-run"],
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

function listRepositoryFiles(repo: string): string[] {
  return readdirSync(repo, { recursive: true })
    .map((entry) => String(entry).replaceAll("\\", "/"))
    .filter((entry) => !entry.startsWith(".git/") && entry !== ".git")
    .sort();
}
