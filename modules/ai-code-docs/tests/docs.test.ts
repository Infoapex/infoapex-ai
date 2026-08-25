import { strict as assert } from "node:assert";
import { test } from "node:test";
import { existsSync, mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateDocs, readRequest } from "../src/docs.js";
import { defaultConfig } from "../src/config.js";

test("readRequest validates the docs contract", () => {
  const root = mkdtempSync(join(tmpdir(), "ai-code-docs-test-"));
  const path = join(root, "request.json");
  writeFileSync(path, JSON.stringify(request()), "utf8");
  assert.equal(readRequest(path).docsId, "DOCS-001");
});

test("generateDocs composes planner, control, worker and review", () => {
  const root = mkdtempSync(join(tmpdir(), "ai-code-docs-test-"));
  const scripts = join(root, "scripts");
  mkdirSync(scripts, { recursive: true });
  const planner = writeScript(scripts, "planner.mjs", "if (process.argv.includes('inspect')) console.log(JSON.stringify({schemaValid:true,lintOk:true})); else console.log(JSON.stringify({status:'DONE'}));");
  const control = writeScript(scripts, "control.mjs", "if (process.argv.at(-1)==='health-check') console.log('{\"status\":\"PASS\"}'); else console.log('docs context');");
  const worker = writeScript(scripts, "worker.mjs", "console.log(JSON.stringify({status:'DONE',taskCommits:{'DOCS-001':'abc123'}}));");
  const review = writeScript(scripts, "review.mjs", "console.log(JSON.stringify({status:'PASS'}));");
  const requestPath = join(root, "request.json");
  const draftPath = join(root, "draft.json");
  const planPath = join(root, "Plan", "docs.md");
  mkdirSync(join(root, "Plan"), { recursive: true });
  writeFileSync(requestPath, JSON.stringify(request({ plannerDraftPath: "draft.json", workerPlanPath: "Plan/docs.md" })), "utf8");
  writeFileSync(draftPath, "{}", "utf8");
  writeFileSync(planPath, "---\nstatus: accepted\n---\n\n```ai-code-worker-plan\n{}\n```\n", "utf8");
  const config = { ...defaultConfig(), planner: [process.execPath, planner], control: [process.execPath, control], worker: [process.execPath, worker], review: [process.execPath, review], defaultEngine: "fake" as const, defaultReviewEngine: "fake" as const };
  const report = generateDocs({ repositoryPath: root, requestPath, plannerDraftPath: "draft.json", workerPlanPath: "Plan/docs.md", engine: "fake", reviewEngine: "fake" }, config);
  assert.equal(report.status, "DONE");
  assert.equal(report.planner.status, "PASS");
  assert.equal(report.control.status, "PASS");
  assert.equal(report.worker.status, "PASS");
  assert.equal(report.review.status, "PASS");
  assert.equal(report.taskCommits["DOCS-001"], "abc123");
});

test("generateDocs fails closed without a planner draft", () => {
  const root = mkdtempSync(join(tmpdir(), "ai-code-docs-test-"));
  const requestPath = join(root, "request.json");
  writeFileSync(requestPath, JSON.stringify(request()), "utf8");
  const report = generateDocs({ repositoryPath: root, requestPath, engine: "fake", reviewEngine: "fake" }, defaultConfig());
  assert.equal(report.status, "BLOCKED");
  assert.equal(report.planner.status, "BLOCKED");
});

test("generateDocs compiles a worker plan through the planner when none is supplied", () => {
  const root = mkdtempSync(join(tmpdir(), "ai-code-docs-test-"));
  const scripts = join(root, "scripts");
  mkdirSync(scripts, { recursive: true });
  const planner = writeScript(scripts, "planner.mjs", "import { writeFileSync } from 'node:fs'; if (process.argv.includes('inspect')) console.log(JSON.stringify({schemaValid:true,lintOk:true})); else if (process.argv.includes('compile')) { const out = process.argv[process.argv.indexOf('--out') + 1]; writeFileSync(out, '---\\nstatus: accepted\\n---\\n\\n```ai-code-worker-plan\\n{}\\n```\\n'); console.log(JSON.stringify({status:'DONE'})); }");
  const control = writeScript(scripts, "control.mjs", "if (process.argv.at(-1)==='health-check') console.log('{\"status\":\"PASS\"}'); else console.log('docs context');");
  const worker = writeScript(scripts, "worker.mjs", "console.log(JSON.stringify({status:'DONE',taskCommits:{'DOCS-002':'def456'}}));");
  const review = writeScript(scripts, "review.mjs", "console.log(JSON.stringify({status:'PASS'}));");
  const requestPath = join(root, "request.json");
  const draftPath = join(root, "draft.json");
  writeFileSync(requestPath, JSON.stringify(request({ docsId: "DOCS-002", runId: "docs-run-002", plannerDraftPath: "draft.json" })), "utf8");
  writeFileSync(draftPath, "{}", "utf8");
  const config = { ...defaultConfig(), planner: [process.execPath, planner], control: [process.execPath, control], worker: [process.execPath, worker], review: [process.execPath, review], defaultEngine: "fake" as const, defaultReviewEngine: "fake" as const };
  const report = generateDocs({ repositoryPath: root, requestPath, engine: "fake", reviewEngine: "fake" }, config);
  assert.equal(report.status, "DONE");
  assert.equal(report.worker.status, "PASS");
  assert.equal(report.taskCommits["DOCS-002"], "def456");
  assert.equal(existsSync(join(root, "Plan", "DOCS-002.md")), true);
});

function request(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: "1.0",
    runId: "docs-run-001",
    docsId: "DOCS-001",
    baseCommit: "BASE",
    headCommit: "HEAD",
    prompt: "Generate documentation.",
    criteria: [{ id: "AC-01", description: "Documentation is generated from evidence." }],
    outputPaths: ["docs/generated/"],
    ...overrides
  };
}

function writeScript(root: string, name: string, body: string): string {
  const path = join(root, name);
  writeFileSync(path, `import process from 'node:process';\n${body}\n`, "utf8");
  return path;
}
