import type {
  EnvironmentCapability,
  EnvironmentCapabilityReport,
  ExecutionBackend,
  ExecutionCommand,
  ExecutionResult
} from "../../src/execution/environment.js";
import { canonicalJson, sha256 } from "../../src/manifest/normalize.js";
import type { JsonValue } from "../../src/schema/json-schema.js";

/** Test double only. It is deliberately outside src/ and production resolution. */
export class TestOnlyFakeExecutionBackend implements ExecutionBackend {
  readonly kind = "isolated" as const;
  readonly testOnly = true as const;

  probe(profile: unknown): EnvironmentCapabilityReport {
    const view = profile as { readonly profileId: string; readonly kind: "isolated" };
    return {
      backend: "test-only-fake-isolated",
      backendVersion: "0.0.0-test",
      profileId: view.profileId,
      kind: view.kind,
      profileSha256: sha256(canonicalJson(profile as JsonValue)),
      supported: true,
      securityBoundary: "os-isolated",
      requestedCapabilities: allCapabilities,
      capabilities: allCapabilities,
      missingCapabilities: [],
      warnings: ["Test double: no production security claim."]
    };
  }

  runSync(_profile: unknown, _command: ExecutionCommand): ExecutionResult {
    return success();
  }

  async run(_profile: unknown, _command: ExecutionCommand): Promise<ExecutionResult> {
    return success();
  }
}

function success(): ExecutionResult {
  return {
    status: 0,
    stdout: "",
    stderr: "",
    timedOut: false,
    outputTruncated: false,
    error: null
  };
}

const allCapabilities: readonly EnvironmentCapability[] = [
  "environment-scrubbed",
  "filesystem-restricted",
  "network-deny-repository-processes",
  "output-limits",
  "process-limits",
  "process-timeout",
  "process-tree-cancellation",
  "worktree-write-mount"
];
