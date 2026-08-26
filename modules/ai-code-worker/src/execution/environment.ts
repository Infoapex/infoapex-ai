import { spawnSync } from "node:child_process";
import { canonicalJson, sha256 } from "../manifest/normalize.js";
import { spawnBuffered } from "../engines/spawn-buffered.js";
import { prepareReportText } from "../runner/redaction.js";
import { SchemaRegistry, type JsonValue } from "../schema/json-schema.js";

export type ExecutionEnvironmentKind = "isolated" | "trusted-local";

export type EnvironmentCapability =
  | "filesystem-restricted"
  | "worktree-write-mount"
  | "network-deny-repository-processes"
  | "environment-scrubbed"
  | "process-timeout"
  | "process-limits"
  | "output-limits"
  | "process-tree-cancellation";

export interface EnvironmentCapabilityReport {
  readonly backend: string;
  readonly backendVersion: string;
  readonly profileId: string;
  readonly kind: ExecutionEnvironmentKind;
  readonly profileSha256: string;
  /** True only when this concrete backend can enforce every requested profile
   * capability. Profile declarations are requirements, never evidence. */
  readonly supported: boolean;
  readonly securityBoundary: "host-process" | "os-isolated";
  readonly requestedCapabilities: readonly EnvironmentCapability[];
  readonly capabilities: readonly EnvironmentCapability[];
  readonly missingCapabilities: readonly EnvironmentCapability[];
  readonly warnings: readonly string[];
}

export interface ExecutionCommand {
  readonly executable: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly timeoutMs: number;
  readonly maximumOutputBytes: number;
  readonly input?: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly shell?: boolean;
}

export interface ExecutionResult {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
  readonly outputTruncated: boolean;
  readonly error: Error | null;
}

/** A backend may report a capability only when its implementation enforces it
 * or a concrete probe has demonstrated it. The profile itself never grants it. */
export interface ExecutionBackend {
  readonly kind: ExecutionEnvironmentKind;
  probe(profile: unknown): EnvironmentCapabilityReport;
  runSync(profile: unknown, command: ExecutionCommand): ExecutionResult;
  run(profile: unknown, command: ExecutionCommand): Promise<ExecutionResult>;
}

/** In-memory binding used by real engine adapters. It is intentionally not
 * serializable: authorization is persisted separately in authorization.json. */
export interface ExecutionBackendBinding {
  readonly backend: ExecutionBackend;
  readonly profile: unknown;
  readonly environment: Readonly<Record<string, string>>;
}

export function createExecutionBackendBinding(
  profile: unknown,
  environment: NodeJS.ProcessEnv = process.env,
  registry = SchemaRegistry.load()
): ExecutionBackendBinding {
  const backend = resolveExecutionBackend(profile, registry);
  const report = backend.probe(profile);
  if (!report.supported) {
    throw new ExecutionBackendUnavailableError(
      report.kind === "isolated" ? "ISOLATED_BACKEND_UNAVAILABLE" : "TRUSTED_LOCAL_PROFILE_REQUIRED",
      `Execution backend ${report.backend} cannot enforce profile ${report.profileId}.`
    );
  }

  return {
    backend,
    profile,
    environment: Object.fromEntries(
      Object.entries(environment).filter((entry): entry is [string, string] => entry[1] !== undefined)
    )
  };
}

/** Honest fallback for a user-controlled host. It is not a host security boundary. */
export class TrustedLocalExecutionBackend implements ExecutionBackend {
  readonly kind = "trusted-local" as const;

  constructor(private readonly registry = SchemaRegistry.load()) {}

  probe(profile: unknown): EnvironmentCapabilityReport {
    const view = readProfile(profile, this.registry);
    const requestedCapabilities = requestedCapabilitiesFor(view);
    const capabilities: readonly EnvironmentCapability[] = view.kind === "trusted-local"
      ? trustedLocalCapabilities
      : [];
    const missingCapabilities = requestedCapabilities.filter((capability) => !capabilities.includes(capability));

    return reportFor({
      backend: "trusted-local",
      backendVersion: "1.0.0",
      profile,
      view,
      supported: view.kind === "trusted-local" && missingCapabilities.length === 0,
      securityBoundary: "host-process",
      requestedCapabilities,
      capabilities,
      missingCapabilities,
      warnings: [
        "trusted-local does not restrict reads or writes outside the worktree.",
        "trusted-local does not restrict repository process network access.",
        "trusted-local does not enforce process-count, CPU or memory limits and cannot prove process-tree cancellation.",
        "Git worktrees and scope verification are repository-integrity controls, not a host security sandbox."
      ]
    });
  }

  runSync(profile: unknown, command: ExecutionCommand): ExecutionResult {
    const { view, env, timeoutMs, maximumOutputBytes } = this.prepare(profile, command);
    const child = spawnSync(command.executable, command.args, {
      cwd: command.cwd,
      env,
      input: command.input,
      encoding: "utf8",
      timeout: timeoutMs,
      maxBuffer: maximumOutputBytes,
      windowsHide: true,
      shell: command.shell ?? false
    });
    const error = child.error ?? null;

    return {
      status: child.status,
      stdout: typeof child.stdout === "string" ? child.stdout : "",
      stderr: typeof child.stderr === "string" ? child.stderr : "",
      timedOut: (error as NodeJS.ErrnoException | null)?.code === "ETIMEDOUT",
      outputTruncated: (error as NodeJS.ErrnoException | null)?.code === "ENOBUFS",
      error
    };
  }

  async run(profile: unknown, command: ExecutionCommand): Promise<ExecutionResult> {
    const { env, timeoutMs, maximumOutputBytes } = this.prepare(profile, command);
    const result = await spawnBuffered(command.executable, command.args, {
      cwd: command.cwd,
      env,
      input: command.input,
      timeoutMs,
      maximumOutputBytes,
      shell: command.shell ?? false
    });

    return {
      status: result.status,
      stdout: result.stdout,
      stderr: result.stderr,
      timedOut: result.timedOut,
      outputTruncated: result.outputTruncated,
      error: result.error
    };
  }

  private prepare(profile: unknown, command: ExecutionCommand): {
    readonly view: EnvironmentProfileView;
    readonly env: Readonly<Record<string, string>>;
    readonly timeoutMs: number;
    readonly maximumOutputBytes: number;
  } {
    const view = readProfile(profile, this.registry);
    const report = this.probe(profile);

    if (!report.supported || view.kind !== "trusted-local") {
      throw new ExecutionBackendUnavailableError(
        "TRUSTED_LOCAL_PROFILE_REQUIRED",
        "TrustedLocalExecutionBackend requires a supported trusted-local profile."
      );
    }

    const allowedVariables = new Set(view.environment.allowedVariables);
    return {
      view,
      env: Object.fromEntries(
        Object.entries(command.env ?? {}).filter(([name]) => allowedVariables.has(name))
      ),
      timeoutMs: Math.min(command.timeoutMs, view.limits.maximumDurationSeconds * 1000),
      maximumOutputBytes: Math.min(command.maximumOutputBytes, view.limits.maximumOutputBytes)
    };
  }
}

/** Safe placeholder until an OS-enforced isolated implementation is installed. */
export class UnavailableIsolatedExecutionBackend implements ExecutionBackend {
  readonly kind = "isolated" as const;

  constructor(private readonly registry = SchemaRegistry.load()) {}

  probe(profile: unknown): EnvironmentCapabilityReport {
    const view = readProfile(profile, this.registry);
    const requestedCapabilities = requestedCapabilitiesFor(view);

    return reportFor({
      backend: "isolated-unavailable",
      backendVersion: "1.0.0",
      profile,
      view,
      supported: false,
      securityBoundary: "host-process",
      requestedCapabilities,
      capabilities: [],
      missingCapabilities: requestedCapabilities,
      warnings: [
        "No probed OS-enforced isolated backend is installed; autonomous isolated writers must fail closed.",
        "Profile declarations describe required policy and do not prove filesystem, network or process isolation."
      ]
    });
  }

  runSync(_profile: unknown, _command: ExecutionCommand): ExecutionResult {
    throw new ExecutionBackendUnavailableError(
      "ISOLATED_BACKEND_UNAVAILABLE",
      "No OS-enforced isolated execution backend is installed."
    );
  }

  async run(_profile: unknown, _command: ExecutionCommand): Promise<ExecutionResult> {
    throw new ExecutionBackendUnavailableError(
      "ISOLATED_BACKEND_UNAVAILABLE",
      "No OS-enforced isolated execution backend is installed."
    );
  }
}

export interface ExecutionEnvironmentPolicy {
  readonly defaultProfile: ExecutionEnvironmentKind;
  readonly allowTrustedLocal: boolean;
}

export interface TrustedLocalAuthorizationInput {
  readonly approved: true;
  readonly authorizedBy: string;
  readonly reason: string;
  readonly approvedAt: string;
  readonly source: "cli" | "api";
}

export interface TrustedLocalAuthorizationRecord {
  readonly approved: true;
  readonly authorizedBy: string;
  readonly reason: string;
  readonly reasonRedacted: boolean;
  readonly reasonSha256: string;
  readonly approvedAt: string;
  readonly source: "cli" | "api";
}

export interface ExecutionEnvironmentInspection {
  readonly report: EnvironmentCapabilityReport;
  readonly authorization: TrustedLocalAuthorizationRecord | null;
  readonly authorized: boolean;
  readonly runnable: boolean;
  readonly findings: readonly ExecutionEnvironmentFinding[];
}

export interface ExecutionEnvironmentFinding {
  readonly code:
    | "EXECUTION_PROFILE_KIND_MISMATCH"
    | "TRUSTED_LOCAL_NOT_AUTHORIZED"
    | "ENVIRONMENT_UNAVAILABLE";
  readonly message: string;
}

/** Selects production backends only. Test fakes live under tests/support. */
export function resolveExecutionBackend(
  profile: unknown,
  registry = SchemaRegistry.load()
): ExecutionBackend {
  const view = readProfile(profile, registry);
  return view.kind === "trusted-local"
    ? new TrustedLocalExecutionBackend(registry)
    : new UnavailableIsolatedExecutionBackend(registry);
}

export function inspectExecutionEnvironment(
  profile: unknown,
  policy: ExecutionEnvironmentPolicy,
  trustedLocalAuthorization?: TrustedLocalAuthorizationInput,
  registry = SchemaRegistry.load()
): ExecutionEnvironmentInspection {
  const view = readProfile(profile, registry);
  const report = resolveExecutionBackend(profile, registry).probe(profile);
  const findings: ExecutionEnvironmentFinding[] = [];
  const authorization = view.kind === "trusted-local"
    ? normalizeTrustedLocalAuthorization(trustedLocalAuthorization)
    : null;

  if (view.kind !== policy.defaultProfile) {
    findings.push({
      code: "EXECUTION_PROFILE_KIND_MISMATCH",
      message: `Configured default execution profile is ${policy.defaultProfile}, but profile ${view.profileId} declares ${view.kind}.`
    });
  }

  if (view.kind === "trusted-local" && !policy.allowTrustedLocal) {
    findings.push({
      code: "TRUSTED_LOCAL_NOT_AUTHORIZED",
      message: "Repository policy does not request trusted-local eligibility (executionEnvironment.allowTrustedLocal=true)."
    });
  }

  if (
    view.kind === "trusted-local" &&
    authorization === null
  ) {
    findings.push({
      code: "TRUSTED_LOCAL_NOT_AUTHORIZED",
      message: "trusted-local execution requires an explicit external CLI/API authorization with a non-empty reason."
    });
  }

  if (!report.supported) {
    findings.push({
      code: "ENVIRONMENT_UNAVAILABLE",
      message: `Execution backend ${report.backend} cannot enforce profile ${view.profileId}; missing: ${report.missingCapabilities.join(", ") || "required backend support"}.`
    });
  }

  const authorized = view.kind === "isolated" || (policy.allowTrustedLocal === true && authorization !== null);
  return {
    report,
    authorization,
    authorized,
    runnable: authorized && findings.length === 0,
    findings
  };
}

export function normalizeTrustedLocalAuthorization(
  value: TrustedLocalAuthorizationInput | undefined
): TrustedLocalAuthorizationRecord | null {
  if (!value || value.approved !== true) return null;
  const authorizedBy = value.authorizedBy.trim();
  const reason = value.reason.trim();
  const approvedAtMs = Date.parse(value.approvedAt);
  if (
    authorizedBy.length === 0 ||
    authorizedBy.length > 128 ||
    /[\r\n\0]/.test(authorizedBy) ||
    reason.length === 0 ||
    !Number.isFinite(approvedAtMs) ||
    (value.source !== "cli" && value.source !== "api")
  ) {
    return null;
  }

  const preparedReason = prepareReportText(reason, 1_000);
  return {
    approved: true,
    authorizedBy,
    reason: preparedReason.text,
    reasonRedacted: preparedReason.redacted,
    reasonSha256: preparedReason.sha256,
    approvedAt: new Date(approvedAtMs).toISOString(),
    source: value.source
  };
}

export class ExecutionBackendUnavailableError extends Error {
  constructor(
    readonly code: "TRUSTED_LOCAL_PROFILE_REQUIRED" | "ISOLATED_BACKEND_UNAVAILABLE",
    message: string
  ) {
    super(message);
    this.name = "ExecutionBackendUnavailableError";
  }
}

const trustedLocalCapabilities: readonly EnvironmentCapability[] = [
  "environment-scrubbed",
  "output-limits",
  "process-timeout"
];

interface EnvironmentProfileView {
  readonly profileId: string;
  readonly kind: ExecutionEnvironmentKind;
  readonly filesystem: {
    readonly hostReadDefault: "deny" | "allow";
    readonly hostWriteDefault: "deny" | "allow";
    readonly mounts: ReadonlyArray<{
      readonly purpose: string;
      readonly access: string;
    }>;
  };
  readonly network: {
    readonly repositoryProcesses: "deny" | "allowlist" | "unrestricted";
  };
  readonly environment: {
    readonly inheritByDefault: false;
    readonly allowedVariables: readonly string[];
  };
  readonly limits: {
    readonly maximumDurationSeconds: number;
    readonly maximumOutputBytes: number;
    readonly maximumProcesses: number | null;
  };
}

function readProfile(profile: unknown, registry: SchemaRegistry): EnvironmentProfileView {
  registry.assertValid("execution-environment.schema.json", profile);
  return profile as EnvironmentProfileView;
}

function requestedCapabilitiesFor(view: EnvironmentProfileView): readonly EnvironmentCapability[] {
  const requested = new Set<EnvironmentCapability>();

  if (!view.environment.inheritByDefault) {
    requested.add("environment-scrubbed");
  }
  if (view.limits.maximumDurationSeconds > 0) {
    requested.add("process-timeout");
  }
  if (view.limits.maximumOutputBytes > 0) {
    requested.add("output-limits");
  }

  if (view.filesystem.hostReadDefault === "deny" && view.filesystem.hostWriteDefault === "deny") {
    requested.add("filesystem-restricted");
  }
  if (view.filesystem.mounts.some((mount) => mount.purpose === "worktree" && mount.access === "read-write")) {
    requested.add("worktree-write-mount");
  }
  if (view.network.repositoryProcesses === "deny") {
    requested.add("network-deny-repository-processes");
  }
  if (typeof view.limits.maximumProcesses === "number" && view.limits.maximumProcesses > 0) {
    requested.add("process-limits");
  }
  if (view.kind === "isolated") {
    requested.add("process-tree-cancellation");
  }

  return [...requested].sort();
}

function reportFor(input: {
  readonly backend: string;
  readonly backendVersion: string;
  readonly profile: unknown;
  readonly view: EnvironmentProfileView;
  readonly supported: boolean;
  readonly securityBoundary: "host-process" | "os-isolated";
  readonly requestedCapabilities: readonly EnvironmentCapability[];
  readonly capabilities: readonly EnvironmentCapability[];
  readonly missingCapabilities: readonly EnvironmentCapability[];
  readonly warnings: readonly string[];
}): EnvironmentCapabilityReport {
  return {
    backend: input.backend,
    backendVersion: input.backendVersion,
    profileId: input.view.profileId,
    kind: input.view.kind,
    profileSha256: sha256(canonicalJson(input.profile as JsonValue)),
    supported: input.supported,
    securityBoundary: input.securityBoundary,
    requestedCapabilities: [...input.requestedCapabilities].sort(),
    capabilities: [...input.capabilities].sort(),
    missingCapabilities: [...input.missingCapabilities].sort(),
    warnings: input.warnings
  };
}
