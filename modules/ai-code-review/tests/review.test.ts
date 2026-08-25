import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { runReview, readRequest } from "../src/review.js";
import type { ReviewConfig } from "../src/types.js";

const workerCli = join(process.cwd(), "tests", "fixtures", "fake-worker.mjs");

test("readRequest validates the review contract", () => {
  const root = mkdtempSync(join(tmpdir(), "aicr-request-"));
  const path = join(root, "request.json");
  writeFileSync(path, JSON.stringify({
    schemaVersion: "1.0",
    runId: "run-001",
    reviewId: "review-001",
    baseCommit: "base",
    headCommit: "head",
    criteria: [{ id: "CRIT-001", description: "The change is correct." }]
  }));

  assert.equal(readRequest(path).reviewId, "review-001");
});

test("runReview composes planner, control and worker into a passing report", () => {
  const root = mkdtempSync(join(tmpdir(), "aicr-run-"));
  const requestPath = join(root, "request.json");
  const draftPath = join(root, "draft.json");
  const plannerPath = join(root, "fake-planner.mjs");
  const controlPath = join(root, "fake-control.mjs");
  writeFileSync(requestPath, JSON.stringify({
    schemaVersion: "1.0",
    runId: "run-002",
    reviewId: "review-002",
    baseCommit: "base",
    headCommit: "head",
    criteria: [{ id: "CRIT-001", description: "The change is correct." }]
  }));
  writeFileSync(draftPath, "{}");
  writeFileSync(plannerPath, "console.log(JSON.stringify({schemaValid:true,lintOk:true}));");
  writeFileSync(controlPath, "const c=process.argv.at(-1); if(c==='health-check') console.log('{\"status\":\"PASS\"}'); else if(c==='memory-brief') console.log('brief'); else console.log('{\"status\":\"PASS\"}');");

  const config: ReviewConfig = {
    schemaVersion: "1.0",
    planner: [process.execPath, plannerPath],
    worker: [process.execPath, workerCli],
    control: [process.execPath, controlPath],
    defaultEngine: "fake"
  };
  const report = runReview({
    repositoryPath: root,
    requestPath,
    plannerDraftPath: draftPath,
    engine: "fake"
  }, config);

  assert.equal(report.status, "PASS");
  assert.equal(report.planner.status, "PASS");
  assert.equal(report.control.status, "PASS");
  assert.equal(report.worker.status, "PASS");
  assert.equal(report.findings.length, 0);
});

test("runReview fails closed when planner validation is omitted", () => {
  const root = mkdtempSync(join(tmpdir(), "aicr-blocked-"));
  const requestPath = join(root, "request.json");
  writeFileSync(requestPath, JSON.stringify({
    schemaVersion: "1.0",
    runId: "run-003",
    reviewId: "review-003",
    baseCommit: "base",
    headCommit: "head",
    criteria: [{ id: "CRIT-001", description: "The change is correct." }]
  }));

  const report = runReview({
    repositoryPath: root,
    requestPath,
    skipPlanner: false,
    skipControl: true,
    engine: "fake",
  }, {
    schemaVersion: "1.0",
    planner: [process.execPath, "missing-planner.mjs"],
    worker: [process.execPath, workerCli],
    control: [process.execPath, "missing-control.mjs"],
    defaultEngine: "fake"
  });

  assert.equal(report.status, "BLOCKED");
  assert.equal(report.planner.status, "BLOCKED");
});
