import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, describe, it } from "node:test";
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

describe("phase 0 e2e harness", () => {
  it("runs doctor -> compile -> status through the CLI without mutating the fixture repository", () => {
    const repo = createFixtureRepository();
    const beforeFiles = listRepositoryFiles(repo);
    const doctor = runCliJson<DoctorCliReport>(["doctor", "--repo", repo, "--json", ...trustedLocalCliAuthorization()]);

    assert.equal(doctor.status, "PASS");

    const compile = runCliJson<CompileCliReport>([
      "compile",
      "--repo",
      repo,
      "--plan",
      "Plan/PHASE-0-E2E.md",
      "--json",
      ...trustedLocalCliAuthorization()
    ]);
    const status = runCliJson<StatusCliReport>(["status", "--repo", repo, "--run-id", compile.runId, "--json"]);

    assert.equal(compile.status, "PASS");
    assert.match(String(compile.manifestSha256), /^[a-f0-9]{64}$/);
    assert.equal(status.status, "PASS");
    assert.equal(status.run.status, "AUTHORIZED");
    assert.equal(status.eventLog.eventCount, 5);
    assert.equal(String(compile.state.runRoot).startsWith(repo), false);
    assert.deepEqual(listRepositoryFiles(repo), beforeFiles);
  });

  it("produces the same manifest hash for identical accepted plan and base commit", () => {
    const first = createFixtureRepository();
    const second = createFixtureRepository();

    const firstCompile = runCliJson<CompileCliReport>([
      "compile", "--repo", first, "--plan", "Plan/PHASE-0-E2E.md", "--json", ...trustedLocalCliAuthorization()
    ]);
    const secondCompile = runCliJson<CompileCliReport>([
      "compile", "--repo", second, "--plan", "Plan/PHASE-0-E2E.md", "--json", ...trustedLocalCliAuthorization()
    ]);

    assert.equal(firstCompile.manifestSha256, secondCompile.manifestSha256);
    assert.equal(firstCompile.runId, secondCompile.runId);
  });
});

interface DoctorCliReport {
  readonly status: string;
}

interface CompileCliReport {
  readonly status: string;
  readonly runId: string;
  readonly manifestSha256: string;
  readonly state: {
    readonly runRoot: string;
  };
}

interface StatusCliReport {
  readonly status: string;
  readonly run: {
    readonly status: string;
  };
  readonly eventLog: {
    readonly eventCount: number;
  };
}

function runCliJson<T>(args: readonly string[]): T {
  const output = execFileSync(process.execPath, [resolve("dist/src/cli.js"), ...args], {
    cwd: tmpdir(),
    encoding: "utf8"
  });

  return JSON.parse(output) as T;
}

function createFixtureRepository(): string {
  const repo = mkdtempSync(join(tmpdir(), "aicw-phase0-e2e-"));
  tempRepos.push(repo);
  stateRoots.push(resolveStateRoot({ repoRoot: repo }).path);

  mkdirSync(join(repo, "Plan"), { recursive: true });
  mkdirSync(join(repo, ".ai-code-worker"), { recursive: true });
  writeFileSync(join(repo, "README.md"), "# Phase 0 fixture\n", "utf8");
  writeFileSync(join(repo, "Plan", "PHASE-0-E2E.md"), acceptedPlan(), "utf8");
  writeFileSync(
    join(repo, ".ai-code-worker", "config.json"),
    JSON.stringify({
      schemaVersion: "1.0",
      executionEnvironment: { defaultProfile: "trusted-local", allowTrustedLocal: true }
    }),
    "utf8"
  );
  writeFileSync(
    join(repo, ".ai-code-worker", "execution-environment.example.json"),
    readFileSync("templates/project/.ai-code-worker/execution-environment.trusted-local.example.json", "utf8"),
    "utf8"
  );
  execFileSync("git", ["init"], { cwd: repo, stdio: "ignore" });
  execFileSync("git", ["add", "README.md", "Plan/PHASE-0-E2E.md"], { cwd: repo, stdio: "ignore" });
  execFileSync("git", ["-c", "user.name=ai-code-worker", "-c", "user.email=worker@example.test", "commit", "-m", "phase0 fixture"], {
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

function trustedLocalCliAuthorization(): string[] {
  return [
    "--allow-trusted-local",
    "--trusted-local-authorized-by",
    "phase0-e2e",
    "--trusted-local-reason",
    "Explicit trusted-local E2E fixture",
    "--trusted-local-approved-at",
    "2026-08-26T09:00:00.000Z"
  ];
}

function acceptedPlan(): string {
  return `---
status: accepted
---

# Phase 0 E2E plan

\`\`\`json ai-code-worker-plan
${JSON.stringify(planBody(), null, 2)}
\`\`\`
`;
}

function planBody(): unknown {
  return {
    goal: "Prove the Phase 0 doctor compile status flow.",
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
        acceptanceCriteria: ["Doctor passes for the fixture repository."],
        verify: ["npm test"],
        concurrencyKeys: ["phase0-e2e"],
        risk: "low"
      },
      {
        id: "STATUS-01",
        kind: "test",
        role: "phase0-worker",
        dependsOn: ["CONTRACT-01"],
        requiredInputs: ["Plan/PHASE-0-E2E.md"],
        allowedPaths: ["src/**", "tests/**"],
        forbiddenPaths: [".git/**"],
        expectedArtifacts: ["dist/src/cli.js"],
        acceptanceCriteria: ["Status reports AUTHORIZED after compile."],
        verify: ["npm test"],
        concurrencyKeys: ["phase0-e2e"],
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

function listRepositoryFiles(repo: string): string[] {
  return readdirSync(repo, { recursive: true })
    .map((entry) => String(entry).replaceAll("\\", "/"))
    .filter((entry) => !entry.startsWith(".git/") && entry !== ".git")
    .sort();
}
