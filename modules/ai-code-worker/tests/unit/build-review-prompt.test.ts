import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildReviewPrompt } from "../../src/review/build-review-prompt.js";

describe("buildReviewPrompt", () => {
  it("includes each task's acceptance criteria and diff", () => {
    const prompt = buildReviewPrompt({
      runId: "run-1",
      reviewId: "run-1-review-abc123",
      graphVersion: 2,
      createdAt: "2026-08-15T10:00:00Z",
      tasks: [
        { id: "CONTRACT-01", acceptanceCriteria: ["Schema compiles.", "No breaking changes."] },
        { id: "BACKEND-01", acceptanceCriteria: [] }
      ],
      diffsByTask: {
        "CONTRACT-01": "diff --git a/schemas/x.json b/schemas/x.json\n+added line"
      }
    });

    assert.match(prompt, /Task CONTRACT-01/);
    assert.match(prompt, /Schema compiles\./);
    assert.match(prompt, /No breaking changes\./);
    assert.match(prompt, /\+added line/);
    assert.match(prompt, /Task BACKEND-01/);
    assert.match(prompt, /\(none declared\)/);
    assert.match(prompt, /\(no diff available for this task\)/);
  });

  it("embeds the exact runId/reviewId/graphVersion/createdAt so the model cannot invent them", () => {
    const prompt = buildReviewPrompt({
      runId: "run-xyz",
      reviewId: "run-xyz-review-deadbeef",
      graphVersion: 5,
      createdAt: "2026-08-15T11:22:33Z",
      tasks: [],
      diffsByTask: {}
    });

    assert.match(prompt, /"runId": "run-xyz"/);
    assert.match(prompt, /"reviewId": "run-xyz-review-deadbeef"/);
    assert.match(prompt, /"graphVersion": 5/);
    assert.match(prompt, /"createdAt": "2026-08-15T11:22:33Z"/);
  });

  it("instructs read-only, no-prose JSON-only output", () => {
    const prompt = buildReviewPrompt({
      runId: "run-1",
      reviewId: "run-1-review-abc",
      graphVersion: 1,
      createdAt: "2026-08-15T10:00:00Z",
      tasks: [],
      diffsByTask: {}
    });

    assert.match(prompt, /read-only/i);
    assert.match(prompt, /no prose/i);
    assert.match(prompt, /have not seen the/i);
  });
});
