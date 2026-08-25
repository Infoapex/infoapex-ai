import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import {
  exportPatch,
  ExportPatchError,
  writeBlockedReport,
  writeIndependentReviewReport
} from "../../src/report/export-artifacts.js";
import { runFake } from "../../src/run/fake-run.js";
import { redactText } from "../../src/runner/redaction.js";
import { EventLog } from "../../src/persistence/event-log.js";
import type { IndependentReviewResult } from "../../src/review/independent-review.js";
import { SchemaRegistry } from "../../src/schema/json-schema.js";
import { resolveStateRoot } from "../../src/state/state-root.js";

const tempDirs: string[] = [];
const stateRoots: string[] = [];
const registry = SchemaRegistry.load({ schemaDirectory: "schemas" });

after(() => {
  for (const root of stateRoots) {
    rmSync(root, { recursive: true, force: true });
  }

  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function mktemp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function baseReview(overrides: Partial<IndependentReviewResult> = {}): IndependentReviewResult {
  return {
    schemaVersion: "1.0",
    runId: "run-redaction",
    reviewId: "review-redaction",
    reviewer: "fake-reviewer",
    graphVersion: 1,
    createdAt: "2026-08-14T12:00:00Z",
    verdict: "fail",
    criterionCoverage: [],
    findings: [],
    ...overrides
  };
}

describe("security: exported patches fail closed on secrets", () => {
  it("refuses to export a patch whose diff contains a secret-looking string", () => {
    const repo = mktemp("aicw-redaction-patch-");
    execFileSync("git", ["init"], { cwd: repo, stdio: "ignore" });
    writeFileSync(join(repo, "config.txt"), "placeholder\n", "utf8");
    execFileSync("git", ["add", "config.txt"], { cwd: repo, stdio: "ignore" });
    commit(repo, "base");
    const baseCommit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim();

    writeFileSync(join(repo, "config.txt"), 'api_key = "abcdefgh12345678"\n', "utf8");
    execFileSync("git", ["add", "config.txt"], { cwd: repo, stdio: "ignore" });
    commit(repo, "leak a secret");
    const headCommit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim();

    assert.throws(
      () => exportPatch({ repositoryPath: repo, baseCommit, headCommit }),
      (error: unknown) => error instanceof ExportPatchError && error.code === "SECRET_DETECTED"
    );
  });

  it("exports normally when the diff has no secret-looking content", () => {
    const repo = mktemp("aicw-redaction-patch-clean-");
    execFileSync("git", ["init"], { cwd: repo, stdio: "ignore" });
    writeFileSync(join(repo, "notes.txt"), "hello\n", "utf8");
    execFileSync("git", ["add", "notes.txt"], { cwd: repo, stdio: "ignore" });
    commit(repo, "base");
    const baseCommit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim();

    writeFileSync(join(repo, "notes.txt"), "hello\nworld\n", "utf8");
    execFileSync("git", ["add", "notes.txt"], { cwd: repo, stdio: "ignore" });
    commit(repo, "harmless change");
    const headCommit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim();

    const patch = exportPatch({ repositoryPath: repo, baseCommit, headCommit });
    assert.match(patch.patchText, /\+world/);
  });
});

function commit(repo: string, message: string): void {
  execFileSync("git", ["-c", "user.name=ai-code-worker", "-c", "user.email=worker@example.test", "commit", "-m", message], {
    cwd: repo,
    env: { ...process.env, GIT_AUTHOR_DATE: "2026-08-01T10:00:00Z", GIT_COMMITTER_DATE: "2026-08-01T10:00:00Z" },
    stdio: "ignore"
  });
}

describe("security: BLOCKED.md redacts and caps free-text fields", () => {
  it("redacts a secret embedded in the cause text", () => {
    const runRoot = mktemp("aicw-redaction-blocked-");

    const result = writeBlockedReport({
      runRoot,
      runId: "run-blocked-secret",
      cause: "Gate failed while token: sk-abcdefghijklmnop was still set in the environment.",
      lastSafeState: "n/a",
      evidencePaths: [],
      resumeInstructions: "n/a"
    });

    assert.equal(result.redacted, true);
    const content = readFileSync(result.path, "utf8");
    assert.doesNotMatch(content, /sk-abcdefghijklmnop/);
    assert.match(content, /\[REDACTED\]/);
  });

  it("truncates a cause field larger than the report text cap", () => {
    const runRoot = mktemp("aicw-redaction-truncate-");
    const oversizedCause = "x".repeat(9_000);

    const result = writeBlockedReport({
      runRoot,
      runId: "run-blocked-oversized",
      cause: oversizedCause,
      lastSafeState: "n/a",
      evidencePaths: [],
      resumeInstructions: "n/a"
    });

    assert.equal(result.truncated, true);
    const content = readFileSync(result.path, "utf8");
    assert.match(content, /\[TRUNCATED: \d+ additional characters omitted\]/);
    assert.ok(content.length < oversizedCause.length + 500, "report must not persist the full oversized text verbatim");
  });
});

describe("security: independent review findings are redacted before persisting", () => {
  it("redacts secret-looking evidence in both findings and criterion coverage", () => {
    const runRoot = mktemp("aicw-redaction-review-");
    const review = baseReview({
      criterionCoverage: [
        {
          criterionId: "AC-01",
          verdict: "contradicted",
          tests: [],
          commands: ["test"],
          evidence: "Test log shows password=Sup3rSecret! leaking into stdout."
        }
      ],
      findings: [
        {
          id: "REV-001",
          severity: "blocking",
          category: "security",
          criterionIds: ["AC-01"],
          files: ["backend/config.ts"],
          evidence: "Committed file contains api_key: abcdefgh12345678 in plaintext."
        }
      ]
    });

    const result = writeIndependentReviewReport({ runRoot, review, registry });

    assert.equal(result.redacted, true);
    const persisted = JSON.parse(readFileSync(result.path, "utf8")) as IndependentReviewResult;
    assert.doesNotMatch(persisted.criterionCoverage[0]!.evidence, /Sup3rSecret/);
    assert.doesNotMatch(persisted.findings[0]!.evidence, /abcdefgh12345678/);
    assert.deepEqual(registry.validate("independent-review.schema.json", persisted), { valid: true, errors: [] });
  });

  it("leaves ordinary evidence untouched", () => {
    const runRoot = mktemp("aicw-redaction-review-clean-");
    const review = baseReview({
      findings: [
        {
          id: "REV-002",
          severity: "blocking",
          category: "correctness",
          criterionIds: ["AC-02"],
          files: ["backend/service.ts"],
          evidence: "Concurrent refresh accepts the same token twice."
        }
      ]
    });

    const result = writeIndependentReviewReport({ runRoot, review, registry });

    assert.equal(result.redacted, false);
    const persisted = JSON.parse(readFileSync(result.path, "utf8")) as IndependentReviewResult;
    assert.equal(persisted.findings[0]!.evidence, "Concurrent refresh accepts the same token twice.");
  });
});

describe("security: event log payloads never carry secret-looking content", () => {
  it("holds for a full fake run's event log", () => {
    const repo = createSingleWriterRepository();
    const report = runFake({ repositoryPath: repo, planPath: "Plan/RUN.md", runId: "run-redaction-events", now: "2026-08-01T10:00:00Z" });
    assert.equal(report.status, "DONE");

    const events = new EventLog(report.state.eventLogPath!, registry).read().events;
    assert.ok(events.length > 0);

    for (const event of events) {
      for (const [key, value] of Object.entries(event.payload)) {
        if (typeof value === "string") {
          assert.equal(redactText(value).redacted, false, `event ${event.type}.payload.${key} looked like it contained a secret: ${value}`);
        }
      }
    }
  });
});

function createSingleWriterRepository(): string {
  const repo = mktemp("aicw-redaction-events-");
  stateRoots.push(resolveStateRoot({ repoRoot: repo }).path);

  execFileSync("git", ["init"], { cwd: repo, stdio: "ignore" });
  mkdirSync(join(repo, "Plan"), { recursive: true });
  writeFileSync(join(repo, "README.md"), "# fixture\n", "utf8");
  writeFileSync(
    join(repo, "Plan", "RUN.md"),
    `---
status: accepted
---

# Redaction fixture plan

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
  commit(repo, "redaction fixture");

  return repo;
}
