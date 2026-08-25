import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  estimateClaudePercentFromTokens,
  fitTokensPerPercentPoint,
  SEEDED_CLAUDE_CALIBRATION_POINTS
} from "../../src/benchmark/claude-calibration.js";

describe("claude calibration", () => {
  it("seeds exactly the 6 real pairs documented in docs/BENCHMARKS.md", () => {
    assert.equal(SEEDED_CLAUDE_CALIBRATION_POINTS.length, 6);
    for (const point of SEEDED_CLAUDE_CALIBRATION_POINTS) {
      assert.ok(point.tokens > 0);
      assert.ok(point.percent > 0);
    }
  });

  it("fits the median tokens-per-percent-point ratio, robust to the single high/low outlier", () => {
    // Ratios: 13200, 11700, 9400, 11550, 11760, 11700 -> sorted: 9400, 11550, 11700,
    // 11700, 11760, 13200 -> median of the two middle values (11700, 11700) = 11700.
    const ratio = fitTokensPerPercentPoint();

    assert.equal(ratio, 11_700);
  });

  it("computes a lower ratio (fewer points needed per pp) from a hand-picked point set", () => {
    const ratio = fitTokensPerPercentPoint([
      { tokens: 10_000, percent: 5 },
      { tokens: 20_000, percent: 5 }
    ]);

    // Ratios 2000 and 4000 -> median 3000.
    assert.equal(ratio, 3000);
  });

  it("throws rather than silently dividing by an empty calibration set", () => {
    assert.throws(() => fitTokensPerPercentPoint([]));
  });

  it("estimates percent from tokens using the fitted ratio, and reports the sample size used", () => {
    const estimate = estimateClaudePercentFromTokens(23_400);

    assert.equal(estimate.tokensPerPercentPoint, 11_700);
    assert.equal(estimate.percent, 2);
    assert.equal(estimate.sampleSize, 6);
  });

  it("accepts a caller-supplied point set instead of the seeded default", () => {
    const estimate = estimateClaudePercentFromTokens(6000, [{ tokens: 12_000, percent: 1 }]);

    assert.equal(estimate.tokensPerPercentPoint, 12_000);
    assert.equal(estimate.percent, 0.5);
    assert.equal(estimate.sampleSize, 1);
  });
});
