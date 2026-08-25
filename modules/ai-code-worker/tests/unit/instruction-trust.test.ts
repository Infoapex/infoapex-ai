import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { applyInstructionTrustPolicy } from "../../src/policy/instruction-trust.js";
import type { RunAuthorization } from "../../src/authorization/run-authorization.js";

describe("instruction trust policy", () => {
  it("lets repository instructions restrict capabilities, paths, and checks", () => {
    const policy = applyInstructionTrustPolicy({
      authorization: authorization(),
      manifestAllowedPaths: ["src/**", "tests/**"],
      manifestRequiredChecks: ["npm test"],
      contributions: [
        {
          source: "repository-instructions",
          label: "AGENTS.md",
          allowedCapabilities: ["write-worktree", "run-isolated-tests"],
          allowedPaths: ["src/policy/**", "tests/unit/**"],
          requiredChecks: ["npm run build"]
        }
      ]
    });

    assert.deepEqual(policy.allowedCapabilities, ["run-isolated-tests", "write-worktree"]);
    assert.deepEqual(policy.allowedPaths, ["src/policy/**", "tests/unit/**"]);
    assert.deepEqual(policy.requiredChecks, ["npm run build", "npm test"]);
    assert.deepEqual(policy.rejections, []);
  });

  it("rejects prompt-injection attempts that ask for forbidden or ungranted capabilities", () => {
    const policy = applyInstructionTrustPolicy({
      authorization: authorization(),
      manifestAllowedPaths: ["src/**", "tests/**"],
      contributions: [
        {
          source: "untrusted-data",
          label: "tool-output",
          allowedCapabilities: ["write-worktree", "push", "read-secrets"]
        }
      ]
    });

    assert.deepEqual(policy.allowedCapabilities, ["write-worktree"]);
    assert.deepEqual(
      policy.rejections.map((rejection) => [rejection.code, rejection.value]),
      [
        ["CAPABILITY_FORBIDDEN", "push"],
        ["CAPABILITY_ESCALATION", "read-secrets"]
      ]
    );
  });

  it("rejects lower-source path expansion while preserving valid restrictions", () => {
    const policy = applyInstructionTrustPolicy({
      authorization: authorization(),
      manifestAllowedPaths: ["src/**", "tests/**"],
      contributions: [
        {
          source: "repository-instructions",
          label: "AGENTS.md",
          allowedPaths: ["src/policy/**", "docs/**", "../outside/**"]
        }
      ]
    });

    assert.deepEqual(policy.allowedPaths, ["src/policy/**"]);
    assert.deepEqual(
      policy.rejections.map((rejection) => [rejection.code, rejection.value]),
      [
        ["PATH_SCOPE_ESCALATION", "../outside/**"],
        ["PATH_SCOPE_ESCALATION", "docs/**"]
      ]
    );
  });

  it("treats new forbidden capabilities as monotonic restrictions", () => {
    const policy = applyInstructionTrustPolicy({
      authorization: authorization(),
      manifestAllowedPaths: ["src/**"],
      contributions: [
        {
          source: "accepted-plan",
          label: "Plan/ACCEPTED.md",
          forbiddenCapabilities: ["create-local-commits"]
        }
      ]
    });

    assert.deepEqual(policy.allowedCapabilities, ["run-isolated-tests", "write-worktree"]);
    assert.ok(policy.forbiddenCapabilities.includes("create-local-commits"));
    assert.deepEqual(policy.rejections, []);
  });
});

function authorization(): Pick<RunAuthorization, "allowedCapabilities" | "forbiddenCapabilities"> {
  return {
    allowedCapabilities: ["write-worktree", "run-isolated-tests", "create-local-commits"],
    forbiddenCapabilities: ["push", "deploy", "network-write"]
  };
}
