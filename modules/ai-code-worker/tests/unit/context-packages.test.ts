import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, describe, it } from "node:test";
import { computeContextPackageDigest } from "../../src/context-provider/context-package-digest.js";
import { compileTaskContextPackages, writeContextPackageArtifacts } from "../../src/context-provider/context-packages.js";
import type { ContextPackage, ContextProvider } from "../../src/context-provider/types.js";

const tempDirs: string[] = [];

after(() => {
  for (const directory of tempDirs) rmSync(directory, { recursive: true, force: true });
});

function example(): ContextPackage {
  return JSON.parse(readFileSync("templates/reports/context-package.example.json", "utf8")) as ContextPackage;
}

describe("context package consumer", () => {
  const producerSchemaPath = resolve("../ai-code-control/contracts/context-package.v1.schema.json");

  it("keeps the vendored consumer schema aligned with the canonical producer schema", {
    skip: !existsSync(producerSchemaPath)
  }, () => {
    const producer = JSON.parse(readFileSync(producerSchemaPath, "utf8"));
    const consumer = JSON.parse(readFileSync("schemas/context-package.schema.json", "utf8"));
    for (const schema of [producer, consumer]) {
      delete schema.$id;
      delete schema.title;
    }
    assert.deepEqual(consumer, producer);
  });

  it("recomputes the canonical producer digest independently", () => {
    const contextPackage = example();
    assert.equal(computeContextPackageDigest(contextPackage), contextPackage.contextDigest);
  });

  it("keeps digest stable across source, omission, and diagnostic order", () => {
    const contextPackage = example();
    const reordered: ContextPackage = {
      ...contextPackage,
      packageId: "ctx-second-instance",
      createdAt: "2026-08-28T12:00:00Z",
      sources: [...contextPackage.sources].reverse(),
      budget: { ...contextPackage.budget, omittedSources: [...contextPackage.budget.omittedSources].reverse() },
      diagnostics: [...contextPackage.diagnostics].reverse()
    };

    assert.equal(computeContextPackageDigest(reordered), contextPackage.contextDigest);
  });

  it("exports only validated package results with a deterministic task index", () => {
    const runRoot = mkdtempSync(join(tmpdir(), "aicw-context-package-"));
    tempDirs.push(runRoot);
    const contextPackage = example();

    const index = writeContextPackageArtifacts(runRoot, "observe", {
      "ICM-02": { status: "OK", value: contextPackage },
      "ICM-03": { status: "ERROR", reason: "compiler unavailable" }
    });

    assert.deepEqual(index.packages.map((entry) => entry.taskId), ["ICM-02", "ICM-03"]);
    assert.equal(index.packages[0]?.contextDigest, contextPackage.contextDigest);
    assert.equal(index.packages[1]?.status, "ERROR");
    assert.deepEqual(
      JSON.parse(readFileSync(join(runRoot, "tasks", "ICM-02", "context-package.v1.json"), "utf8")),
      contextPackage
    );
  });

  it("accepts only request-bound packages with independently valid digests", async () => {
    const root = mkdtempSync(join(tmpdir(), "aicw-context-binding-"));
    tempDirs.push(root);
    const manifestPath = join(root, "manifest.json");
    writeFileSync(manifestPath, JSON.stringify({ runId: "run-001", tasks: [{ id: "ICM-02" }] }), "utf8");
    const contextPackage = example();

    const valid = await compileTaskContextPackages({
      provider: packageProvider(contextPackage),
      manifestPath,
      manifestSha256: "a".repeat(64),
      maximumTokens: 4000
    });
    assert.equal(valid["ICM-02"]?.status, "OK");

    const drifted = await compileTaskContextPackages({
      provider: packageProvider({ ...contextPackage, compilerVersion: "changed-without-new-digest" }),
      manifestPath,
      manifestSha256: "a".repeat(64),
      maximumTokens: 4000
    });
    assert.deepEqual(drifted["ICM-02"], { status: "ERROR", reason: "context package digest mismatch for task ICM-02" });
  });

  it("refuses to persist a schema-valid package containing unredacted secret-looking content", async () => {
    const root = mkdtempSync(join(tmpdir(), "aicw-context-secret-"));
    tempDirs.push(root);
    const manifestPath = join(root, "manifest.json");
    writeFileSync(manifestPath, JSON.stringify({ runId: "run-001", tasks: [{ id: "ICM-02" }] }), "utf8");
    const changed = {
      ...example(),
      diagnostics: [{ code: "CTX_SECRET", severity: "warning" as const, message: "\"api_key\": \"secret-value-12345\"" }]
    };
    const contextPackage: ContextPackage = { ...changed, contextDigest: computeContextPackageDigest(changed) };

    const result = await compileTaskContextPackages({
      provider: packageProvider(contextPackage),
      manifestPath,
      manifestSha256: "a".repeat(64),
      maximumTokens: 4000
    });

    assert.deepEqual(result["ICM-02"], {
      status: "ERROR",
      reason: "context package contains unredacted secret-looking content for task ICM-02"
    });
  });
});

function packageProvider(contextPackage: ContextPackage): ContextProvider {
  const unavailable = async () => ({ status: "UNAVAILABLE" as const, reason: "not used" });
  return {
    kind: "ai-code-control",
    health: unavailable,
    brief: unavailable,
    findSymbol: unavailable,
    impact: unavailable,
    compileContext: async () => ({ status: "OK", value: contextPackage }),
    refresh: unavailable
  };
}
