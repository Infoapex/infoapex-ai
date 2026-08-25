import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { evaluateChangedPaths, matchesPolicyPattern, normalizePolicyPath } from "../../src/policy/scope-policy.js";

describe("scope policy", () => {
  it("allows exact paths and recursive repository-relative globs", () => {
    const result = evaluateChangedPaths(
      {
        allowedPaths: ["src/**", "package.json"],
        forbiddenPaths: [".git/**"]
      },
      ["src/run/fake-run.ts", "package.json"]
    );

    assert.equal(result.status, "PASS");
    assert.deepEqual(result.findings, []);
  });

  it("blocks forbidden paths before allowed catch-all patterns", () => {
    const result = evaluateChangedPaths(
      {
        allowedPaths: ["**"],
        forbiddenPaths: [".git/**", "secrets/**"]
      },
      [".git/config", "secrets/token.txt"]
    );

    assert.equal(result.status, "BLOCK");
    assert.deepEqual(
      result.findings.map((finding) => finding.code),
      ["PATH_FORBIDDEN", "PATH_FORBIDDEN"]
    );
  });

  it("blocks paths outside the task allowedPaths", () => {
    const result = evaluateChangedPaths(
      {
        allowedPaths: ["src/**"],
        forbiddenPaths: []
      },
      ["tests/unit/new.test.ts"]
    );

    assert.equal(result.status, "BLOCK");
    assert.equal(result.findings[0]?.code, "PATH_OUTSIDE_SCOPE");
  });

  it("rejects absolute and traversal paths", () => {
    assert.equal(normalizePolicyPath("../outside.txt"), null);
    assert.equal(normalizePolicyPath("src/../../outside.txt"), null);

    const result = evaluateChangedPaths(
      {
        allowedPaths: ["src/**"],
        forbiddenPaths: []
      },
      ["../outside.txt"]
    );

    assert.equal(result.status, "BLOCK");
    assert.equal(result.findings[0]?.code, "PATH_OUTSIDE_SCOPE");
  });

  it("matches single-segment wildcards without crossing directories", () => {
    assert.equal(matchesPolicyPattern("src/*.ts", "src/cli.ts"), true);
    assert.equal(matchesPolicyPattern("src/*.ts", "src/run/fake-run.ts"), false);
  });
});
