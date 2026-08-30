import { canonicalJson, sha256 } from "../manifest/normalize.js";
import { spawnBuffered } from "../engines/spawn-buffered.js";
import { SchemaRegistry, type JsonValue } from "../schema/json-schema.js";

export type EnvironmentCapability =
  | "filesystem-restricted"
  | "worktree-write-mount"
  | "network-deny-repository-processes"
  | "network-provider-only-adapter-control-plane"
  | "environment-scrubbed"
  | "process-limits"
  | "output-limits"
  | "process-tree-cancellation";

export interface EnvironmentCapabilityReport {
  readonly backend: string;
  readonly backendVersion: string;
  readonly profileId: string;
  readonly kind: "isolated" | "trusted-local";
  readonly profileSha256: string;
  readonly supported: boolean;
  readonly capabilities: readonly EnvironmentCapability[];
  readonly missingCapabilities: readonly EnvironmentCapability[];
  readonly warnings: readonly string[];
}

export interface ExecutionEnvironment {
  doctor(profile: unknown): EnvironmentCapabilityReport;
}

export class LocalIsolatedExecutionEnvironment implements ExecutionEnvironment {
  constructor(private readonly registry = SchemaRegistry.load()) {}

  doctor(profile: unknown): EnvironmentCapabilityReport {
    this.registry.assertValid("execution-environment.schema.json", profile);
    const view = profile as EnvironmentProfileView;
    const capabilities = new Set<EnvironmentCapability>();
    const warnings: string[] = [];

    if (view.kind !== "isolated") {
      warnings.push("Local isolated backend only supports isolated profiles for autonomous writers.");
    }

    if (view.filesystem.hostReadDefault === "deny" && view.filesystem.hostWriteDefault === "deny") {
      capabilities.add("filesystem-restricted");
    }

    if (view.filesystem.mounts.some((mount) => mount.purpose === "worktree" && mount.access === "read-write")) {
      capabilities.add("worktree-write-mount");
    }

    if (!view.environment.inheritByDefault) {
      capabilities.add("environment-scrubbed");
    }

    if (view.limits.maximumDurationSeconds > 0 && view.limits.maximumProcesses > 0) {
      capabilities.add("process-limits");
      capabilities.add("process-tree-cancellation");
    }

    if (view.limits.maximumOutputBytes > 0) {
      capabilities.add("output-limits");
    }

    if (view.network.repositoryProcesses === "deny") {
      capabilities.add("network-deny-repository-processes");
      warnings.push("Network deny is policy-visible, but the local backend cannot prove host-level network isolation.");
    }

    if (view.network.adapterControlPlane === "provider-only") {
      capabilities.add("network-provider-only-adapter-control-plane");
      warnings.push("Adapter control-plane restriction is policy-visible, but the local backend cannot prove host-level network isolation.");
    }

    const missingCapabilities = requiredCapabilities.filter((capability) => !capabilities.has(capability));

    return {
      backend: "local-isolated",
      backendVersion: "0.1.0",
      profileId: view.profileId,
      kind: view.kind,
      profileSha256: sha256(canonicalJson(profile as JsonValue)),
      supported: view.kind === "isolated" && missingCapabilities.length === 0,
      capabilities: [...capabilities].sort(),
      missingCapabilities,
      warnings
    };
  }

  async run(command: {
    readonly executable: string;
    readonly args: readonly string[];
    readonly cwd: string;
    readonly timeoutMs: number;
    readonly maximumOutputBytes: number;
    readonly env?: Readonly<Record<string, string>>;
  }): Promise<{
    readonly status: number | null;
    readonly stdout: string;
    readonly stderr: string;
    readonly timedOut: boolean;
    readonly outputTruncated: boolean;
  }> {
    const result = await spawnBuffered(command.executable, command.args, {
      cwd: command.cwd,
      env: command.env ?? {},
      timeoutMs: command.timeoutMs,
      maximumOutputBytes: command.maximumOutputBytes,
      shell: false
    });

    return {
      status: result.status,
      stdout: result.stdout,
      stderr: result.stderr,
      timedOut: result.timedOut,
      outputTruncated: result.outputTruncated
    };
  }
}

export class FakeExecutionEnvironment implements ExecutionEnvironment {
  constructor(private readonly registry = SchemaRegistry.load()) {}

  doctor(profile: unknown): EnvironmentCapabilityReport {
    this.registry.assertValid("execution-environment.schema.json", profile);

    const view = profile as EnvironmentProfileView;
    const capabilities = new Set<EnvironmentCapability>();
    const warnings: string[] = [];

    if (view.kind === "isolated" && view.filesystem.hostReadDefault === "deny" && view.filesystem.hostWriteDefault === "deny") {
      capabilities.add("filesystem-restricted");
    }

    if (view.filesystem.mounts.some((mount) => mount.purpose === "worktree" && mount.access === "read-write")) {
      capabilities.add("worktree-write-mount");
    }

    if (view.network.repositoryProcesses === "deny") {
      capabilities.add("network-deny-repository-processes");
    }

    if (view.network.adapterControlPlane === "provider-only") {
      capabilities.add("network-provider-only-adapter-control-plane");
    }

    if (!view.environment.inheritByDefault) {
      capabilities.add("environment-scrubbed");
    }

    if (view.limits.maximumDurationSeconds > 0 && view.limits.maximumProcesses > 0) {
      capabilities.add("process-limits");
    }

    if (view.limits.maximumOutputBytes > 0) {
      capabilities.add("output-limits");
    }

    capabilities.add("process-tree-cancellation");

    if (view.kind !== "isolated") {
      warnings.push("Fake Phase 0 backend models isolated support only; trusted-local is accepted by schema but not autonomous-safe.");
    }

    const missingCapabilities = requiredCapabilities.filter((capability) => !capabilities.has(capability));

    return {
      backend: "fake-isolated",
      backendVersion: "0.0.0",
      profileId: view.profileId,
      kind: view.kind,
      profileSha256: sha256(canonicalJson(profile as JsonValue)),
      supported: missingCapabilities.length === 0 && view.kind === "isolated",
      capabilities: [...capabilities].sort(),
      missingCapabilities,
      warnings
    };
  }
}

// network-provider-only-adapter-control-plane is intentionally NOT required here.
// adapterControlPlane has been a required schema field since execution-environment
// v1 but was never read by either backend, so no existing profile or consumer has
// ever had to satisfy it. Adding it to requiredCapabilities now would silently flip
// `supported` from true to false for those profiles. Promote it once policy owners
// decide that is the intended compatibility break.
const requiredCapabilities: readonly EnvironmentCapability[] = [
  "filesystem-restricted",
  "worktree-write-mount",
  "network-deny-repository-processes",
  "environment-scrubbed",
  "process-limits",
  "output-limits",
  "process-tree-cancellation"
];

interface EnvironmentProfileView {
  readonly profileId: string;
  readonly kind: "isolated" | "trusted-local";
  readonly filesystem: {
    readonly hostReadDefault: "deny" | "allow";
    readonly hostWriteDefault: "deny" | "allow";
    readonly mounts: ReadonlyArray<{
      readonly purpose: string;
      readonly access: string;
    }>;
  };
  readonly network: {
    readonly repositoryProcesses: "deny" | "allowlist";
    readonly adapterControlPlane: "provider-only" | "allowlist" | "deny";
  };
  readonly environment: {
    readonly inheritByDefault: boolean;
  };
  readonly limits: {
    readonly maximumDurationSeconds: number;
    readonly maximumOutputBytes: number;
    readonly maximumProcesses: number;
  };
}
