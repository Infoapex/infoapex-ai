import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { runFake } from "../../src/run/fake-run.js";
import { redactText } from "../../src/runner/redaction.js";
import { SchemaRegistry } from "../../src/schema/json-schema.js";
import { resolveStateRoot } from "../../src/state/state-root.js";

interface OtelSpanRecord {
  readonly schemaVersion: string;
  readonly traceId: string;
  readonly spanId: string;
  readonly parentSpanId: string | null;
  readonly name: string;
  readonly startTimeUnixMillis: number;
  readonly endTimeUnixMillis: number;
  readonly attributes: Record<string, unknown>;
  readonly events: readonly { name: string; timeUnixMillis: number; attributes: Record<string, unknown> }[];
}

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

function commit(repo: string, message: string): void {
  execFileSync("git", ["-c", "user.name=ai-code-worker", "-c", "user.email=worker@example.test", "commit", "-m", message], {
    cwd: repo,
    env: { ...process.env, GIT_AUTHOR_DATE: "2026-08-01T10:00:00Z", GIT_COMMITTER_DATE: "2026-08-01T10:00:00Z" },
    stdio: "ignore"
  });
}

function createSingleTaskRepository(runId: string): string {
  const repo = mktemp(`aicw-otel-${runId}-`);
  stateRoots.push(resolveStateRoot({ repoRoot: repo }).path);

  execFileSync("git", ["init"], { cwd: repo, stdio: "ignore" });
  mkdirSync(join(repo, "Plan"), { recursive: true });
  writeFileSync(join(repo, "README.md"), "# fixture\n", "utf8");
  writeFileSync(
    join(repo, "Plan", "RUN.md"),
    `---
status: accepted
---

# OTel fixture plan

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
  commit(repo, "otel fixture");

  return repo;
}

function readSpans(path: string): OtelSpanRecord[] {
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as OtelSpanRecord);
}

describe("telemetry: disabled by default", () => {
  it("produces no otel-spans.jsonl and behaves identically when INFOAPEX_OTEL_ENABLED is unset", () => {
    const repo = createSingleTaskRepository("disabled");
    const previous = process.env.INFOAPEX_OTEL_ENABLED;
    delete process.env.INFOAPEX_OTEL_ENABLED;
    try {
      const report = runFake({ repositoryPath: repo, planPath: "Plan/RUN.md", runId: "run-otel-disabled", now: "2026-08-01T10:00:00Z" });
      assert.equal(report.status, "DONE");
      assert.equal(existsSync(join(report.state.runRoot!, "otel-spans.jsonl")), false);
    } finally {
      if (previous !== undefined) process.env.INFOAPEX_OTEL_ENABLED = previous;
    }
  });
});

describe("telemetry: enabled produces a valid, correlated, redacted span export", () => {
  it("exports schema-valid spans sharing one trace ID, with gate spans nested under their task span", () => {
    const repo = createSingleTaskRepository("enabled");
    const previous = process.env.INFOAPEX_OTEL_ENABLED;
    process.env.INFOAPEX_OTEL_ENABLED = "1";
    let report: ReturnType<typeof runFake>;
    try {
      report = runFake({ repositoryPath: repo, planPath: "Plan/RUN.md", runId: "run-otel-enabled", now: "2026-08-01T10:00:00Z" });
    } finally {
      if (previous === undefined) delete process.env.INFOAPEX_OTEL_ENABLED;
      else process.env.INFOAPEX_OTEL_ENABLED = previous;
    }
    assert.equal(report.status, "DONE");

    const spansPath = join(report.state.runRoot!, "otel-spans.jsonl");
    assert.equal(existsSync(spansPath), true);
    const spans = readSpans(spansPath);
    assert.ok(spans.length > 0, "expected at least one exported span");

    for (const span of spans) {
      assert.deepEqual(registry.validate("otel-span.schema.json", span), { valid: true, errors: [] });
    }

    const traceIds = new Set(spans.map((span) => span.traceId));
    assert.equal(traceIds.size, 1, "every span for one run must share one trace ID");

    // Paired spans are named after their *start* event and only get their end time set
    // when the matching finish event arrives - there is no separate "task.finished"-
    // named span by design (ADR-0012: one span per pair, not one per event).
    const taskSpan = spans.find((span) => span.name === "task.started");
    const gateSpan = spans.find((span) => span.name === "gate.started" && span.parentSpanId === taskSpan?.spanId);
    assert.ok(taskSpan, "expected a task.started span");
    assert.ok(gateSpan, "expected a gate.started span nested under the task span");
    assert.ok(taskSpan!.endTimeUnixMillis >= taskSpan!.startTimeUnixMillis, "a paired span must be ended (have a real end time), not left at its start time");
    assert.ok(gateSpan!.endTimeUnixMillis >= gateSpan!.startTimeUnixMillis, "a paired span must be ended (have a real end time), not left at its start time");

    // task.finished/gate.finished never appear as span names - the finish event's
    // payload is merged into the already-open span as attributes and ends it in place.
    assert.equal(spans.some((span) => span.name === "task.finished"), false);
    assert.equal(spans.some((span) => span.name === "gate.finished"), false);
  });

  it("never leaks a filesystem path or secret-shaped string into any span attribute or event", () => {
    const repo = createSingleTaskRepository("leak-check");
    const previous = process.env.INFOAPEX_OTEL_ENABLED;
    process.env.INFOAPEX_OTEL_ENABLED = "1";
    let report: ReturnType<typeof runFake>;
    try {
      report = runFake({ repositoryPath: repo, planPath: "Plan/RUN.md", runId: "run-otel-leak-check", now: "2026-08-01T10:00:00Z" });
    } finally {
      if (previous === undefined) delete process.env.INFOAPEX_OTEL_ENABLED;
      else process.env.INFOAPEX_OTEL_ENABLED = previous;
    }
    assert.equal(report.status, "DONE");

    const spans = readSpans(join(report.state.runRoot!, "otel-spans.jsonl"));
    assert.ok(spans.length > 0);

    for (const span of spans) {
      for (const [key, value] of allAttributeEntries(span)) {
        if (typeof value !== "string") continue;
        assert.doesNotMatch(value, /[A-Za-z]:\\|\/home\/|\/Users\//, `span ${span.name}.${key} looked like a filesystem path: ${value}`);
        assert.equal(redactText(value).redacted, false, `span ${span.name}.${key} looked like it contained a secret: ${value}`);
      }
    }
  });
});

function* allAttributeEntries(span: OtelSpanRecord): Generator<readonly [string, unknown]> {
  yield* Object.entries(span.attributes);
  for (const event of span.events) {
    yield* Object.entries(event.attributes);
  }
}
