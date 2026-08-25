import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildRepairPrompt } from "../../src/repair/build-repair-prompt.js";
import type { RepairTask } from "../../src/repair/repair-task.js";
import type { IndependentReviewFinding } from "../../src/review/independent-review.js";

function task(overrides: Partial<RepairTask> = {}): RepairTask {
  return {
    schemaVersion: "1.0",
    id: "REPAIR-001",
    runId: "run-prompt",
    graphVersion: 2,
    sourceFindingIds: ["REV-001"],
    allowedPaths: ["backend/Auth/**"],
    forbiddenPaths: [],
    verify: ["backend-tests"],
    dependsOn: [],
    maximumAttempts: 3,
    status: "PENDING",
    createdAt: "2026-08-15T09:00:00Z",
    ...overrides
  };
}

function finding(overrides: Partial<IndependentReviewFinding> = {}): IndependentReviewFinding {
  return {
    id: "REV-001",
    severity: "blocking",
    category: "correctness",
    criterionIds: ["AC-01"],
    files: ["backend/Auth/RefreshTokenService.cs"],
    evidence: "Concurrent refresh accepts the same token twice.",
    ...overrides
  };
}

describe("buildRepairPrompt", () => {
  it("embeds the allowed paths, matching findings, and verify commands", () => {
    const result = buildRepairPrompt({ task: task(), findings: [finding()] });

    assert.match(result.prompt, /## Allowed paths\n- backend\/Auth\/\*\*/);
    assert.match(result.prompt, /\[REV-001\] \(blocking\/correctness\) backend\/Auth\/RefreshTokenService\.cs: Concurrent refresh accepts the same token twice\./);
    assert.match(result.prompt, /## Verification\nAfter your changes, all of the following must pass:\n- backend-tests/);
    assert.equal(result.redacted, false);
    assert.equal(result.truncated, false);
  });

  it("only includes findings that belong to this task's sourceFindingIds", () => {
    const result = buildRepairPrompt({
      task: task({ sourceFindingIds: ["REV-001"] }),
      findings: [finding(), finding({ id: "REV-002", evidence: "unrelated finding" })]
    });

    assert.match(result.prompt, /REV-001/);
    assert.doesNotMatch(result.prompt, /REV-002/);
  });

  it("redacts secret-looking evidence before embedding it in the prompt", () => {
    const result = buildRepairPrompt({
      task: task(),
      findings: [finding({ evidence: "Config leak: api_key = abcdefgh12345678 committed in plaintext." })]
    });

    assert.equal(result.redacted, true);
    assert.doesNotMatch(result.prompt, /abcdefgh12345678/);
    assert.match(result.prompt, /\[REDACTED\]/);
  });

  it("caps oversized evidence before embedding it in the prompt", () => {
    const result = buildRepairPrompt({
      task: task(),
      findings: [finding({ evidence: "x".repeat(9_000) })]
    });

    assert.equal(result.truncated, true);
    assert.match(result.prompt, /\[TRUNCATED: \d+ additional characters omitted\]/);
  });
});
