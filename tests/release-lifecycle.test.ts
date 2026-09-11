import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { fullInstall } from "../src/full-install.js";
import { checkInstall, rollbackRelease, upgrade } from "../src/release-lifecycle.js";

test("full installation can be checked, upgraded, and rolled back from a verified release journal", () => {
  const repository = mkdtempSync(join(tmpdir(), "apex-release-lifecycle-"));
  try {
    mkdirSync(join(repository, ".infoapex-ai"), { recursive: true });
    writeFileSync(join(repository, ".infoapex-ai", "config.json"), JSON.stringify({ schemaVersion: "1.0", mode: "integrated", handoffRoot: ".infoapex-ai/runs", planner: { enabled: true }, worker: { enabled: true } }));
    const installed = fullInstall({
      repositoryRoot: repository,
      bundleRoot: process.cwd(),
      profile: "generic",
      layout: { backendDir: "backend", frontendDir: "frontend", mlDir: "ml" },
      repair: false
    });
    assert.equal(installed.status, "DONE", JSON.stringify(installed));
    assert.equal(checkInstall(repository, process.cwd()).status, "PASS");

    const before = readFileSync(join(repository, ".ai-code-worker", "config.json"), "utf8");
    const result = upgrade(repository, process.cwd());
    assert.equal(result.status, "PASS", JSON.stringify(result));
    const journalPath = String(result.journalPath);
    assert.equal(existsSync(journalPath), true);

    writeFileSync(join(repository, ".ai-code-worker", "config.json"), JSON.stringify({ schemaVersion: "1.0", changedByTest: true }));
    const rollback = rollbackRelease(repository, null, false);
    assert.equal(rollback.status, "PASS", JSON.stringify(rollback));
    assert.equal(readFileSync(join(repository, ".ai-code-worker", "config.json"), "utf8"), before);
  } finally {
    rmSync(repository, { recursive: true, force: true });
  }
});
