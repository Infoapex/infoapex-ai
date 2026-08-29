import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { buildSemanticTaskInputs } from "../../src/snapshots/semantic-task-inputs.js";
import type { ContextPackage } from "../../src/context-provider/types.js";

const roots: string[] = [];

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe("semantic task inputs", () => {
  it("hashes only declared or selected contract and toolchain sources", () => {
    const root = repository();
    const contextPackage = packageWithSources([
      source("package.json", "file", "1"),
      source("contracts/api.schema.json", "contract", "2")
    ]);
    const initial = buildSemanticTaskInputs({
      repositoryRoot: root,
      task: task(),
      contextPackage,
      projectConfig: { contextPackage: { mode: "observe", maximumTokens: 1000 } }
    });

    writeFileSync(join(root, "unselected.md"), "changed but irrelevant\n", "utf8");
    const repeated = buildSemanticTaskInputs({
      repositoryRoot: root,
      task: task(),
      contextPackage: packageWithSources([...contextPackage.sources].reverse()),
      projectConfig: { contextPackage: { mode: "observe", maximumTokens: 1000 } }
    });

    assert.deepEqual(initial, repeated);
    assert.deepEqual(initial.contractHashes, [
      { canonicalRef: "contracts/api.schema.json", sha256: "2".repeat(64) }
    ]);
    assert.notEqual(initial.toolchainConfigHash, "0".repeat(64));
  });

  it("canonicalizes quality-gate JSON and order-insensitive scope policy lists", () => {
    const root = repository();
    writeFileSync(
      join(root, ".ai-code-worker", "quality-gates.json"),
      JSON.stringify({ schemaVersion: "1.0", gates: [{ id: "unit", executable: "npm", args: ["test"] }, { id: "unrelated", executable: "x" }] }),
      "utf8"
    );
    const first = buildSemanticTaskInputs({
      repositoryRoot: root,
      task: task(),
      projectConfig: { syncRootPolicy: { sequentialWriter: "warn", parallelWriters: "block" } }
    });
    writeFileSync(
      join(root, ".ai-code-worker", "quality-gates.json"),
      JSON.stringify({ gates: [{ id: "unrelated", executable: "changed" }, { args: ["test"], executable: "npm", id: "unit" }], schemaVersion: "1.0" }),
      "utf8"
    );
    const reordered = buildSemanticTaskInputs({
      repositoryRoot: root,
      task: { ...task(), allowedPaths: ["src/b/**", "src/a/**"] },
      projectConfig: { syncRootPolicy: { sequentialWriter: "warn", parallelWriters: "block" } }
    });

    assert.equal(first.qualityGateConfigHash, reordered.qualityGateConfigHash);
    assert.equal(first.policyHash, reordered.policyHash);

    writeFileSync(
      join(root, ".ai-code-worker", "quality-gates.json"),
      JSON.stringify({ schemaVersion: "1.0", gates: [{ id: "unit", executable: "npm", args: ["test:changed"] }] }),
      "utf8"
    );
    const relevantChanged = buildSemanticTaskInputs({ repositoryRoot: root, task: task() });
    assert.notEqual(first.qualityGateConfigHash, relevantChanged.qualityGateConfigHash);
  });
});

function repository(): string {
  const root = mkdtempSync(join(tmpdir(), "aicw-semantic-"));
  roots.push(root);
  mkdirSync(join(root, ".ai-code-worker"), { recursive: true });
  mkdirSync(join(root, "contracts"), { recursive: true });
  writeFileSync(join(root, ".ai-code-worker", "quality-gates.json"), '{"schemaVersion":"1.0","gates":[]}\n', "utf8");
  writeFileSync(join(root, "package.json"), '{"name":"example"}\n', "utf8");
  writeFileSync(join(root, "contracts", "api.schema.json"), '{}\n', "utf8");
  writeFileSync(join(root, "unselected.md"), "initial\n", "utf8");
  return root;
}

function task() {
  return {
    requiredInputs: ["contracts/api.schema.json", "package.json"],
    allowedPaths: ["src/a/**", "src/b/**"],
    forbiddenPaths: ["secrets/**"],
    concurrencyKeys: ["api", "backend"],
    verify: ["unit"],
    risk: "high",
    routing: null
  } as const;
}

function packageWithSources(sources: ContextPackage["sources"]): ContextPackage {
  return {
    schemaVersion: "1.0",
    packageId: "pkg-1",
    runId: "run-1",
    taskId: "TASK-1",
    manifestSha256: "a".repeat(64),
    compilerVersion: "ai-code-control/1.0",
    sources,
    budget: { measurement: "characters-fallback", maximumTokens: 1000, estimatedTokens: 10, omittedSources: [] },
    diagnostics: [],
    contextDigest: "b".repeat(64),
    createdAt: "2026-08-28T00:00:00Z"
  };
}

function source(canonicalRef: string, sourceType: "file" | "contract", hashCharacter: string): ContextPackage["sources"][number] {
  return {
    sourceId: canonicalRef,
    sourceType,
    canonicalRef,
    sourceHash: hashCharacter.repeat(64),
    sourceCommit: null,
    authority: "canonical",
    selectionReason: "test"
  };
}
