import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import {
  TrustedLocalExecutionBackend,
  inspectExecutionEnvironment,
  resolveExecutionBackend
} from "../../src/execution/environment.js";
import { canonicalJson, sha256 } from "../../src/manifest/normalize.js";
import type { JsonValue } from "../../src/schema/json-schema.js";
import { TestOnlyFakeExecutionBackend } from "../support/fake-execution-backend.js";

describe("execution backend capability truthfulness", () => {
  it("does not turn an isolated profile declaration into enforced capabilities", () => {
    const profile = readJson("templates/project/.ai-code-worker/execution-environment.example.json");
    const report = resolveExecutionBackend(profile).probe(profile);

    assert.equal(report.backend, "isolated-unavailable");
    assert.equal(report.supported, false);
    assert.equal(report.kind, "isolated");
    assert.equal(report.securityBoundary, "host-process");
    assert.equal(report.profileSha256, sha256(canonicalJson(profile as JsonValue)));
    assert.deepEqual(report.capabilities, []);
    assert.ok(report.requestedCapabilities.includes("filesystem-restricted"));
    assert.ok(report.missingCapabilities.includes("network-deny-repository-processes"));
    assert.ok(report.missingCapabilities.includes("process-limits"));
    assert.ok(report.missingCapabilities.includes("process-tree-cancellation"));
  });

  it("reports only controls the trusted-local backend actually applies", () => {
    const profile = trustedLocalProfile();
    const report = new TrustedLocalExecutionBackend().probe(profile);

    assert.equal(report.backend, "trusted-local");
    assert.equal(report.supported, true);
    assert.equal(report.securityBoundary, "host-process");
    assert.deepEqual(report.capabilities, [
      "environment-scrubbed",
      "output-limits",
      "process-timeout"
    ]);
    assert.equal(report.capabilities.includes("filesystem-restricted"), false);
    assert.equal(report.capabilities.includes("network-deny-repository-processes"), false);
    assert.equal(report.capabilities.includes("process-limits"), false);
    assert.equal(report.capabilities.includes("process-tree-cancellation"), false);
    assert.match(report.warnings.join("\n"), /integrity controls, not a host security sandbox/i);
  });

  it("requires explicit trusted-local policy authorization", () => {
    const profile = trustedLocalProfile();
    const denied = inspectExecutionEnvironment(profile, {
      defaultProfile: "trusted-local",
      allowTrustedLocal: false
    });
    const authorized = inspectExecutionEnvironment(profile, {
      defaultProfile: "trusted-local",
      allowTrustedLocal: true
    }, trustedLocalAuthorization());

    assert.equal(denied.report.supported, true);
    assert.equal(denied.authorized, false);
    assert.equal(denied.runnable, false);
    assert.ok(denied.findings.some((finding) => finding.code === "TRUSTED_LOCAL_NOT_AUTHORIZED"));
    assert.equal(authorized.authorized, true);
    assert.equal(authorized.runnable, true);
    assert.deepEqual(authorized.findings, []);
    assert.equal(authorized.authorization?.authorizedBy, "test-owner");
  });

  it("rejects trusted-local authorization without an explicit approval timestamp", () => {
    const inspection = inspectExecutionEnvironment(
      trustedLocalProfile(),
      { defaultProfile: "trusted-local", allowTrustedLocal: true },
      {
        approved: true,
        authorizedBy: "test-owner",
        reason: "Incomplete trusted-local fixture",
        approvedAt: "",
        source: "cli"
      }
    );

    assert.equal(inspection.authorized, false);
    assert.equal(inspection.runnable, false);
    assert.ok(inspection.findings.some((finding) => finding.code === "TRUSTED_LOCAL_NOT_AUTHORIZED"));
  });

  it("rejects trusted-local profiles that falsely declare host isolation", () => {
    const profile = trustedLocalProfile() as Record<string, unknown>;
    const filesystem = profile.filesystem as Record<string, unknown>;
    const limits = profile.limits as Record<string, unknown>;
    const falseClaims = {
      ...profile,
      filesystem: {
        ...filesystem,
        hostReadDefault: "deny",
        hostWriteDefault: "deny"
      },
      limits: {
        ...limits,
        maximumProcesses: 64
      }
    };

    assert.throws(() => new TrustedLocalExecutionBackend().probe(falseClaims));
  });

  it("scrubs variables and caps output through the trusted-local runner", async () => {
    const profile = trustedLocalProfile();
    const environment = new TrustedLocalExecutionBackend();
    const result = await environment.run(profile, {
      executable: process.execPath,
      args: [
        "-e",
        "process.stdout.write((process.env.SECRET_TOKEN ? 'leaked' : 'clean') + ':' + (process.env.NO_COLOR ?? 'missing') + 'x'.repeat(100))"
      ],
      cwd: process.cwd(),
      timeoutMs: 5000,
      maximumOutputBytes: 16,
      env: { SECRET_TOKEN: "secret", NO_COLOR: "1" }
    });

    assert.equal(result.status, 0);
    assert.match(result.stdout, /^clean:1/);
    assert.equal(result.stdout.includes("leaked"), false);
    assert.equal(result.outputTruncated, true);
    assert.ok(Buffer.byteLength(result.stdout) <= 16);
  });

  it("keeps the capability-granting fake under test support only", () => {
    const fake = new TestOnlyFakeExecutionBackend();
    const production = resolveExecutionBackend(
      readJson("templates/project/.ai-code-worker/execution-environment.example.json")
    );

    assert.equal(fake.testOnly, true);
    assert.equal(fake.probe(readJson("templates/project/.ai-code-worker/execution-environment.example.json")).supported, true);
    assert.equal(production.constructor === TestOnlyFakeExecutionBackend, false);
    assert.equal(production.probe(readJson("templates/project/.ai-code-worker/execution-environment.example.json")).supported, false);
  });
});

function trustedLocalProfile(): unknown {
  return readJson("templates/project/.ai-code-worker/execution-environment.trusted-local.example.json");
}

function trustedLocalAuthorization() {
  return {
    approved: true as const,
    authorizedBy: "test-owner",
    reason: "Explicit trusted local unit test",
    approvedAt: "2026-08-26T09:00:00.000Z",
    source: "api" as const
  };
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8"));
}
