import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { canonicalJson, sha256 } from "../manifest/normalize.js";
import { spawnBuffered } from "../engines/spawn-buffered.js";
import { localEngineProcessRunner, type EngineProcessRunner, type EngineProcessSyncResult } from "../engines/process-runner.js";
import type { BufferedProcessResult } from "../engines/spawn-buffered.js";
import { SchemaRegistry, type JsonValue } from "../schema/json-schema.js";

export type EnvironmentCapability =
  | "filesystem-restricted"
  | "worktree-write-mount"
  | "network-deny-repository-processes"
  | "network-provider-only-adapter-control-plane"
  | "provider-execution-isolated"
  | "environment-scrubbed"
  | "process-limits"
  | "output-limits"
  | "process-tree-cancellation";

export interface EnvironmentCapabilityReport {
  readonly backend: string;
  readonly backendVersion: string;
  readonly profileId: string;
  readonly kind: "isolated" | "trusted-local";
  readonly securityBoundary: "host-process" | "os-isolated" | "simulated";
  readonly profileSha256: string;
  readonly supported: boolean;
  /** Whether the provider CLI itself is executed inside the declared boundary. */
  readonly providerSupported: boolean;
  readonly requestedCapabilities: readonly EnvironmentCapability[];
  readonly capabilities: readonly EnvironmentCapability[];
  readonly missingCapabilities: readonly EnvironmentCapability[];
  readonly warnings: readonly string[];
  readonly providerWarnings: readonly string[];
}

export interface ExecutionEnvironment {
  doctor(profile: unknown): EnvironmentCapabilityReport;
  readonly runWithProfileSync?: (profile: unknown, command: EnvironmentCommand) => EnvironmentRunResult;
  /** Returns the provider process path, or null when the backend cannot isolate it. */
  readonly providerProcessRunner?: (profile: unknown, provider: "codex" | "claude") => EngineProcessRunner | null;
}

export interface EnvironmentCommand {
  readonly executable: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly timeoutMs: number;
  readonly maximumOutputBytes: number;
  readonly input?: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly linkedDirectories?: readonly {
    readonly from: string;
    readonly to: string;
  }[];
}

export interface EnvironmentRunResult {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
  readonly outputTruncated: boolean;
  readonly error: Error | null;
}

export class LocalIsolatedExecutionEnvironment implements ExecutionEnvironment {
  constructor(private readonly registry = SchemaRegistry.load()) {}

  doctor(profile: unknown): EnvironmentCapabilityReport {
    this.registry.assertValid("execution-environment.schema.json", profile);
    const view = profile as EnvironmentProfileView;
    const capabilities = new Set<EnvironmentCapability>();
    const warnings: string[] = [];
    const providerWarnings: string[] = ["The local backend does not execute Codex/Claude inside an isolated provider boundary."];

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
      securityBoundary: "host-process",
      requestedCapabilities: requiredCapabilities,
      profileSha256: sha256(canonicalJson(profile as JsonValue)),
      supported: view.kind === "isolated" && missingCapabilities.length === 0,
      providerSupported: false,
      capabilities: [...capabilities].sort(),
      missingCapabilities,
      warnings,
      providerWarnings
    };
  }

  async run(command: EnvironmentCommand): Promise<EnvironmentRunResult> {
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
      outputTruncated: result.outputTruncated,
      error: result.error
    };
  }
}

/**
 * Docker-backed isolated execution for repository-owned commands. The image is
 * pinned by digest and the container receives only the requested worktree mount;
 * host networking, inherited credentials and host writes are not available.
 * Provider execution is allowed only through the separately provisioned,
 * internally networked egress proxy described by the profile.
 */
export class DockerExecutionEnvironment implements ExecutionEnvironment {
  constructor(
    private readonly registry = SchemaRegistry.load(),
    private readonly dockerRunner: EngineProcessRunner = localEngineProcessRunner
  ) {}

  doctor(profile: unknown): EnvironmentCapabilityReport {
    this.registry.assertValid("execution-environment.schema.json", profile);
    const view = profile as EnvironmentProfileView;
    const base = reportBase(profile, view, "docker", "1.0.0", "os-isolated");
    const required = requestedCapabilities(view);
    const warnings: string[] = [];
    const providerWarnings: string[] = [];
    let providerSupported = false;

    if (view.kind !== "isolated") {
      warnings.push("DockerExecutionEnvironment requires an isolated profile.");
    }
    if (view.backend?.type !== "docker") {
      warnings.push("The isolated profile does not declare a pinned Docker backend.");
    }
    if (view.providerExecution?.mode !== "isolated-container") {
      providerWarnings.push("Docker provider execution requires an explicit isolated-container provider runner.");
    } else {
      const providerProbe = probeDockerProvider(view, this.dockerRunner);
      providerSupported = providerProbe.ok;
      providerWarnings.push(...providerProbe.warnings);
    }

    const probe = view.kind === "isolated" && view.backend?.type === "docker"
      ? probeDocker(view, this.dockerRunner)
      : { ok: false, warnings: [] as string[] };
    warnings.push(...probe.warnings);
    const repositoryCapabilities = required.filter((capability) => capability !== "provider-execution-isolated");
    const capabilities = probe.ok && warnings.length === 0
      ? [...repositoryCapabilities, ...(providerSupported ? ["provider-execution-isolated" as const] : [])]
      : [];

    return {
      ...base,
      supported: view.kind === "isolated" && probe.ok && warnings.length === 0,
      providerSupported,
      requestedCapabilities: required,
      capabilities,
      // `supported` is the repository-command contract. Provider readiness is
      // reported independently through providerSupported/providerWarnings and
      // the public isolation gate checks both contracts together.
      missingCapabilities: repositoryCapabilities.filter((capability) => !capabilities.includes(capability)),
      warnings,
      providerWarnings
    };
  }

  async runWithProfile(profile: unknown, command: EnvironmentCommand): Promise<EnvironmentRunResult> {
    return this.runWithProfileSync(profile, command);
  }

  runWithProfileSync(profile: unknown, command: EnvironmentCommand): EnvironmentRunResult {
    const report = this.doctor(profile);
    if (!report.supported) {
      return unavailableResult(report.warnings.join(" ") || "Docker isolated backend is unavailable.");
    }
    try {
      return runDocker(profile as EnvironmentProfileView, command, this.dockerRunner);
    } catch (error) {
      return unavailableResult(error instanceof Error ? error.message : "Docker command could not be prepared.");
    }
  }

  providerProcessRunner(profile: unknown, provider: "codex" | "claude"): EngineProcessRunner | null {
    this.registry.assertValid("execution-environment.schema.json", profile);
    const view = profile as EnvironmentProfileView;
    const report = this.doctor(profile);
    return report.providerSupported ? dockerProviderProcessRunner(view, this.dockerRunner, provider) : null;
  }
}

export class FakeExecutionEnvironment implements ExecutionEnvironment {
  constructor(private readonly registry = SchemaRegistry.load()) {}

  doctor(profile: unknown): EnvironmentCapabilityReport {
    this.registry.assertValid("execution-environment.schema.json", profile);

    const view = profile as EnvironmentProfileView;
    const capabilities = new Set<EnvironmentCapability>();
    const warnings: string[] = [];
    const providerWarnings: string[] = [];

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

    // This is useful only for deterministic contract tests. The fake backend
    // must remain visibly simulated and can never satisfy the public release
    // gate's os-isolated boundary check.
    if (view.providerExecution?.mode === "simulated") {
      capabilities.add("provider-execution-isolated");
    } else {
      providerWarnings.push("Fake execution requires providerExecution.mode=simulated for the provider contract test.");
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
      securityBoundary: "simulated",
      requestedCapabilities: requiredCapabilities,
      profileSha256: sha256(canonicalJson(profile as JsonValue)),
      supported: missingCapabilities.length === 0 && view.kind === "isolated",
      providerSupported: view.kind === "isolated" && view.providerExecution?.mode === "simulated",
      capabilities: [...capabilities].sort(),
      missingCapabilities,
      warnings,
      providerWarnings
    };
  }

  providerProcessRunner(profile: unknown, _provider: "codex" | "claude"): EngineProcessRunner | null {
    const report = this.doctor(profile);
    return report.providerSupported ? localEngineProcessRunner : null;
  }
}

// These are requirements for an autonomous isolated writer, not merely for a
// repository-owned quality gate. In particular, a provider CLI that is still
// spawned by the host process cannot be treated as isolated just because its
// worktree and gates are isolated.
const requiredCapabilities: readonly EnvironmentCapability[] = [
  "filesystem-restricted",
  "worktree-write-mount",
  "network-deny-repository-processes",
  "environment-scrubbed",
  "process-limits",
  "output-limits",
  "process-tree-cancellation"
];

export function resolveExecutionEnvironment(
  profile: unknown,
  registry = SchemaRegistry.load()
): ExecutionEnvironment {
  registry.assertValid("execution-environment.schema.json", profile);
  return (profile as EnvironmentProfileView).backend?.type === "docker"
    ? new DockerExecutionEnvironment(registry)
    : new LocalIsolatedExecutionEnvironment(registry);
}

interface EnvironmentProfileView {
  readonly profileId: string;
  readonly kind: "isolated" | "trusted-local";
  readonly backend?: {
    readonly type: "docker";
    readonly image: string;
    readonly imageDigest: string;
  };
  readonly providerExecution?: {
    readonly mode: "simulated" | "isolated-container" | "host-process";
    readonly egressProxy?: {
      readonly networkName: string;
      readonly proxyUrl: string;
      readonly policySha256: string;
      readonly proxyContainer: string;
      readonly proxyImageDigest: string;
    };
    readonly credentialVariables?: readonly string[];
    readonly providers?: readonly ("codex" | "claude")[];
  };
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
    readonly allowedVariables: readonly string[];
  };
  readonly limits: {
    readonly maximumDurationSeconds: number;
    readonly maximumOutputBytes: number;
    readonly maximumProcesses: number;
    readonly maximumMemoryBytes?: number | null;
    readonly maximumCpuUnits?: number | null;
  };
}

function reportBase(
  profile: unknown,
  view: EnvironmentProfileView,
  backend: string,
  backendVersion: string,
  securityBoundary: EnvironmentCapabilityReport["securityBoundary"]
): Pick<EnvironmentCapabilityReport, "backend" | "backendVersion" | "profileId" | "kind" | "securityBoundary" | "profileSha256"> {
  return {
    backend,
    backendVersion,
    profileId: view.profileId,
    kind: view.kind,
    securityBoundary,
    profileSha256: sha256(canonicalJson(profile as JsonValue))
  };
}

function requestedCapabilities(view: EnvironmentProfileView): readonly EnvironmentCapability[] {
  const capabilities = new Set<EnvironmentCapability>();
  if (view.filesystem.hostReadDefault === "deny" && view.filesystem.hostWriteDefault === "deny") capabilities.add("filesystem-restricted");
  if (view.filesystem.mounts.some((mount) => mount.purpose === "worktree" && mount.access === "read-write")) capabilities.add("worktree-write-mount");
  if (view.network.repositoryProcesses === "deny") capabilities.add("network-deny-repository-processes");
  if (view.kind === "isolated") capabilities.add("provider-execution-isolated");
  if (!view.environment.inheritByDefault) capabilities.add("environment-scrubbed");
  if (view.limits.maximumProcesses > 0) capabilities.add("process-limits");
  if (view.limits.maximumOutputBytes > 0) capabilities.add("output-limits");
  if (view.kind === "isolated") capabilities.add("process-tree-cancellation");
  return [...capabilities].sort();
}

function probeDocker(view: EnvironmentProfileView, runner: EngineProcessRunner): { readonly ok: boolean; readonly warnings: readonly string[] } {
  const backend = view.backend;
  if (!backend) return { ok: false, warnings: ["No Docker backend configuration is present."] };
  const warnings: string[] = [];
  const version = runner.runSync("docker", ["version", "--format", "{{.Server.Version}}"], dockerProbeOptions(10_000));
  if (version.status !== 0 || !textOutput(version.stdout).trim()) {
    warnings.push("Docker Engine is unavailable.");
    return { ok: false, warnings };
  }
  const image = `${backend.image}@${backend.imageDigest}`;
  const inspect = runner.runSync("docker", ["image", "inspect", image, "--format", "{{.Id}}"], dockerProbeOptions(10_000));
  if (inspect.status !== 0 || !textOutput(inspect.stdout).trim()) {
    warnings.push("The pinned Docker image is not available locally.");
    return { ok: false, warnings };
  }

  const probeRoot = mkdtempSync(join(tmpdir(), "aicw-docker-probe-"));
  try {
    writeFileSync(join(probeRoot, "host-secret.fixture"), "must-not-be-visible\n", "utf8");
    const script = "const fs=require('node:fs'); if(fs.existsSync('/host-secret.fixture')) process.exit(21); const r=require('node:http').get({host:'1.1.1.1',port:80,path:'/',timeout:500},()=>process.exit(22)); r.on('error',()=>process.exit(0)); r.on('timeout',()=>{r.destroy();process.exit(0)});";
    const result = runner.runSync(
      "docker",
      dockerArgs(view, { executable: "node", args: ["-e", script], cwd: probeRoot, timeoutMs: 5_000, maximumOutputBytes: 2_048 }, probeRoot),
      dockerProbeOptions(15_000)
    );
    if (result.status !== 0) warnings.push("Docker isolation probe failed for filesystem and network boundaries.");
  } finally {
    rmSync(probeRoot, { recursive: true, force: true });
  }
  return { ok: warnings.length === 0, warnings };
}

/**
 * Provider execution is a second Docker contract. The repository probe above
 * proves only the generic worktree boundary; this probe additionally requires
 * both provider binaries in the pinned image and an operator-provisioned,
 * internal Docker network whose only egress path is the pinned proxy.
 */
function probeDockerProvider(
  view: EnvironmentProfileView,
  runner: EngineProcessRunner
): { readonly ok: boolean; readonly warnings: readonly string[] } {
  const execution = view.providerExecution;
  const egress = execution?.egressProxy;
  const warnings: string[] = [];

  if (!egress) {
    return { ok: false, warnings: ["No provider egress proxy attestation is configured."] };
  }
  const credentialVariables = execution?.credentialVariables ?? [];
  const allowedVariables = new Set(view.environment.allowedVariables);
  if (credentialVariables.some((name) => !allowedVariables.has(name))) {
    warnings.push("Provider credential variables must be included in the execution profile environment allowlist.");
  }
  warnings.push(...probeDockerEgress(egress, runner));
  if (warnings.length > 0) return { ok: false, warnings };

  const probeRoot = mkdtempSync(join(tmpdir(), "aicw-provider-probe-"));
  try {
    for (const provider of view.providerExecution?.providers ?? (["codex", "claude"] as const)) {
      const result = runner.runSync(
        "docker",
        dockerArgs(
          view,
          { executable: provider, args: ["--version"], cwd: probeRoot, timeoutMs: 10_000, maximumOutputBytes: 4_096 },
          probeRoot,
          "none"
        ),
        dockerProbeOptions(15_000)
      );
      if (result.status !== 0 || !textOutput(result.stdout).trim()) {
        warnings.push(`The pinned provider image does not expose a usable ${provider} CLI.`);
      }
    }
  } finally {
    rmSync(probeRoot, { recursive: true, force: true });
  }
  return { ok: warnings.length === 0, warnings };
}

function probeDockerEgress(
  egress: NonNullable<NonNullable<EnvironmentProfileView["providerExecution"]>["egressProxy"]>,
  runner: EngineProcessRunner
): readonly string[] {
  const warnings: string[] = [];
  let proxyUrl: URL;
  try {
    proxyUrl = new URL(egress.proxyUrl);
    if (!(["http:", "https:"].includes(proxyUrl.protocol)) || proxyUrl.username || proxyUrl.password) {
      warnings.push("Provider proxy URL must be an HTTP(S) URL without embedded credentials.");
    }
  } catch {
    warnings.push("Provider proxy URL is invalid.");
  }

  const network = dockerJsonInspect(runner, ["network", "inspect", egress.networkName]);
  if (!network) {
    warnings.push("The provider egress Docker network is unavailable.");
  } else {
    const labels = recordValue(network["Labels"]);
    if (network["Internal"] !== true) warnings.push("The provider egress Docker network must be internal.");
    if (labels?.[EGRESS_POLICY_LABEL] !== egress.policySha256) {
      warnings.push("The provider egress network policy hash does not match the execution profile.");
    }
    const containers = recordValue(network["Containers"]);
    if (!containers || !Object.keys(containers).some((id) => id === egress.proxyContainer || recordValue(containers[id])?.["Name"] === egress.proxyContainer || recordValue(containers[id])?.["Name"] === `/${egress.proxyContainer}`)) {
      warnings.push("The attested provider proxy container is not attached to the provider egress network.");
    }
  }

  const proxy = dockerJsonInspect(runner, ["container", "inspect", egress.proxyContainer]);
  if (!proxy) {
    warnings.push("The attested provider proxy container is unavailable.");
  } else {
    const state = recordValue(proxy["State"]);
    const config = recordValue(proxy["Config"]);
    const labels = recordValue(config?.["Labels"]);
    if (state?.["Running"] !== true) warnings.push("The attested provider proxy container is not running.");
    if (proxy["Image"] !== egress.proxyImageDigest) warnings.push("The provider proxy image digest does not match the execution profile.");
    if (labels?.[EGRESS_POLICY_LABEL] !== egress.policySha256 || labels?.[EGRESS_ROLE_LABEL] !== "proxy") {
      warnings.push("The provider proxy container is missing the required policy attestation labels.");
    }
  }

  return warnings;
}

function dockerProviderProcessRunner(view: EnvironmentProfileView, runner: EngineProcessRunner, provider: "codex" | "claude"): EngineProcessRunner {
  const execution = view.providerExecution;
  const egress = execution?.egressProxy;
  if (!egress) throw new Error("Provider egress proxy configuration is missing.");
  if (!(execution.providers ?? ["codex", "claude"]).includes(provider)) {
    throw new Error(`Provider '${provider}' is not enabled by the execution profile.`);
  }
  const credentialVariables = execution.credentialVariables ?? [];
  const allowedVariables = new Set(view.environment.allowedVariables);
  if (credentialVariables.some((name) => !allowedVariables.has(name))) {
    throw new Error("Provider credential variables must be included in the execution profile environment allowlist.");
  }

  const additionalEnvArgs = [
    "-e", `HTTP_PROXY=${egress.proxyUrl}`,
    "-e", `HTTPS_PROXY=${egress.proxyUrl}`,
    "-e", `ALL_PROXY=${egress.proxyUrl}`,
    "-e", "NO_PROXY="
  ];
  for (const name of credentialVariables) additionalEnvArgs.push("-e", name);

  return {
    runSync(executable, args, options) {
      if (options.shell) return invalidSyncResult("Provider execution refuses shell interpolation inside the container.");
      const cwd = resolve(options.cwd);
      return runner.runSync("docker", dockerArgs(
        view,
        { executable, args, cwd, input: options.input, timeoutMs: options.timeoutMs, maximumOutputBytes: options.maximumOutputBytes },
        cwd,
        egress.networkName,
        additionalEnvArgs
      ), {
        ...options,
        cwd,
        env: dockerClientEnvironment(credentialVariables),
        shell: false,
        timeoutMs: Math.min(options.timeoutMs, view.limits.maximumDurationSeconds * 1_000)
      });
    },
    runAsync(executable, args, options) {
      if (options.shell) return Promise.resolve(invalidAsyncResult("Provider execution refuses shell interpolation inside the container."));
      const cwd = resolve(options.cwd);
      return runner.runAsync("docker", dockerArgs(
        view,
        { executable, args, cwd, input: options.input, timeoutMs: options.timeoutMs, maximumOutputBytes: options.maximumOutputBytes },
        cwd,
        egress.networkName,
        additionalEnvArgs
      ), {
        ...options,
        cwd,
        env: dockerClientEnvironment(credentialVariables),
        shell: false,
        timeoutMs: Math.min(options.timeoutMs, view.limits.maximumDurationSeconds * 1_000)
      });
    }
  };
}

const EGRESS_POLICY_LABEL = "com.infoapex.ai/provider-egress-policy-sha256";
const EGRESS_ROLE_LABEL = "com.infoapex.ai/provider-egress-role";

function dockerJsonInspect(runner: EngineProcessRunner, args: readonly string[]): Record<string, unknown> | null {
  const result = runner.runSync("docker", [...args, "--format", "{{json .}}"], dockerProbeOptions(10_000));
  if (result.status !== 0) return null;
  try {
    const value: unknown = JSON.parse(textOutput(result.stdout));
    return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function dockerProbeOptions(timeoutMs: number) {
  return { cwd: process.cwd(), timeoutMs, maximumOutputBytes: 1_048_576, shell: false } as const;
}

function dockerClientEnvironment(credentialVariables: readonly string[]): Readonly<Record<string, string>> {
  // The Docker CLI is the host-side control process. It receives only the
  // variables needed to reach the daemon plus the explicitly allowlisted
  // provider credentials; all other host environment variables are scrubbed.
  const names = [
    "PATH", "SystemRoot", "TEMP", "TMP", "DOCKER_HOST", "DOCKER_CONTEXT",
    "DOCKER_CONFIG", "DOCKER_CERT_PATH", "DOCKER_TLS_VERIFY", ...credentialVariables
  ];
  return Object.fromEntries(names.flatMap((name) => process.env[name] === undefined ? [] : [[name, process.env[name] as string]]));
}

function textOutput(value: string | Buffer | null | undefined): string {
  return typeof value === "string" ? value : value instanceof Buffer ? value.toString("utf8") : "";
}

function invalidSyncResult(message: string): EngineProcessSyncResult {
  return { pid: 0, output: ["", message], stdout: "", stderr: message, status: null, signal: null, error: new Error(message) } as unknown as EngineProcessSyncResult;
}

function invalidAsyncResult(message: string): BufferedProcessResult {
  return { status: null, stdout: "", stderr: message, error: new Error(message), timedOut: false, stopReason: null, outputTruncated: false };
}

function runDocker(view: EnvironmentProfileView, command: EnvironmentCommand, runner: EngineProcessRunner): EnvironmentRunResult {
  const timeoutMs = Math.min(command.timeoutMs, view.limits.maximumDurationSeconds * 1_000);
  const result = runner.runSync("docker", dockerArgs(view, command, command.cwd), {
    cwd: command.cwd,
    input: command.input,
    timeoutMs,
    maximumOutputBytes: command.maximumOutputBytes,
    shell: false
  });
  const error = result.error ?? null;
  return {
    status: result.status,
    stdout: textOutput(result.stdout),
    stderr: textOutput(result.stderr),
    timedOut: (error as NodeJS.ErrnoException | null)?.code === "ETIMEDOUT",
    outputTruncated: (error as NodeJS.ErrnoException | null)?.code === "ENOBUFS",
    error
  };
}

function dockerArgs(
  view: EnvironmentProfileView,
  command: EnvironmentCommand,
  mountRoot: string,
  network = "none",
  additionalEnvArgs: readonly string[] = []
): string[] {
  const backend = view.backend;
  if (!backend) throw new Error("Docker backend configuration is missing.");
  const cwd = resolve(command.cwd);
  const root = resolve(mountRoot);
  const relativeCwd = relative(root, cwd);
  if (relativeCwd.startsWith("..") || relativeCwd.includes(`..${sep}`)) {
    throw new Error("Docker execution cwd must be inside the mounted worktree.");
  }
  const containerCwd = relativeCwd === "" ? "/workspace" : `/workspace/${relativeCwd.split(sep).join("/")}`;
  const mappedArgs = command.args.map((arg) => mapHostPath(arg, root));
  const allowedVariables = new Set(view.environment.allowedVariables);
  const envArgs = Object.entries(command.env ?? {}).flatMap(([name, value]) => {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) || /[\0\r\n]/.test(value)) throw new Error("Invalid Docker environment variable.");
    if (!allowedVariables.has(name)) throw new Error(`Docker environment variable '${name}' is not allowlisted by the execution profile.`);
    return ["-e", `${name}=${value}`];
  });
  const linkedMounts = (command.linkedDirectories ?? []).map((link) => {
    const source = resolve(link.from);
    const target = resolve(link.to);
    const targetRelative = relative(root, target);
    if (targetRelative === ".." || targetRelative.startsWith(`..${sep}`) || isAbsolute(targetRelative)) {
      throw new Error("Docker linked directory target must be inside the mounted worktree.");
    }
    if (source === root || !isAbsolute(source)) {
      throw new Error("Docker linked directory source must be an absolute path outside the worktree.");
    }
    const containerTarget = targetRelative === "" ? "/workspace" : `/workspace/${targetRelative.split(sep).join("/")}`;
    return ["-v", `${source}:${containerTarget}:ro`];
  }).flat();
  return [
    "run", "--rm", "--init", "--network", network, "--read-only", "--cap-drop", "ALL",
    "--security-opt", "no-new-privileges", "--pids-limit", String(view.limits.maximumProcesses),
    ...(view.limits.maximumMemoryBytes ? ["--memory", String(view.limits.maximumMemoryBytes)] : []),
    ...(view.limits.maximumCpuUnits ? ["--cpus", String(view.limits.maximumCpuUnits)] : []),
    "--tmpfs", "/tmp:rw,nosuid,nodev", "-v", `${root}:/workspace:rw`, ...linkedMounts, "-w", containerCwd,
    ...envArgs, ...additionalEnvArgs, `${backend.image}@${backend.imageDigest}`, command.executable, ...mappedArgs
  ];
}

function mapHostPath(value: string, root: string): string {
  if (!isAbsolute(value)) return value;
  const candidate = resolve(value);
  const relativePath = relative(root, candidate);
  if (relativePath === "") return "/workspace";
  if (relativePath !== ".." && !relativePath.startsWith(`..${sep}`) && !isAbsolute(relativePath)) {
    return `/workspace/${relativePath.split(sep).join("/")}`;
  }
  return value;
}

function unavailableResult(message: string): EnvironmentRunResult {
  return { status: null, stdout: "", stderr: message, timedOut: false, outputTruncated: false, error: new Error(message) };
}
