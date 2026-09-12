import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
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
  readonly securityBoundary: "host-process" | "os-isolated" | "simulated";
  readonly profileSha256: string;
  readonly supported: boolean;
  readonly requestedCapabilities: readonly EnvironmentCapability[];
  readonly capabilities: readonly EnvironmentCapability[];
  readonly missingCapabilities: readonly EnvironmentCapability[];
  readonly warnings: readonly string[];
}

export interface ExecutionEnvironment {
  doctor(profile: unknown): EnvironmentCapabilityReport;
}

export interface EnvironmentCommand {
  readonly executable: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly timeoutMs: number;
  readonly maximumOutputBytes: number;
  readonly input?: string;
  readonly env?: Readonly<Record<string, string>>;
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
      capabilities: [...capabilities].sort(),
      missingCapabilities,
      warnings
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
 * Provider control-plane execution is intentionally a separate integration step.
 */
export class DockerExecutionEnvironment implements ExecutionEnvironment {
  constructor(private readonly registry = SchemaRegistry.load()) {}

  doctor(profile: unknown): EnvironmentCapabilityReport {
    this.registry.assertValid("execution-environment.schema.json", profile);
    const view = profile as EnvironmentProfileView;
    const base = reportBase(profile, view, "docker", "1.0.0", "os-isolated");
    const required = requestedCapabilities(view);
    const warnings: string[] = [];

    if (view.kind !== "isolated") {
      warnings.push("DockerExecutionEnvironment requires an isolated profile.");
    }
    if (view.backend?.type !== "docker") {
      warnings.push("The isolated profile does not declare a pinned Docker backend.");
    }

    const probe = view.kind === "isolated" && view.backend?.type === "docker"
      ? probeDocker(view)
      : { ok: false, warnings: [] as string[] };
    warnings.push(...probe.warnings);
    const capabilities = probe.ok && warnings.length === 0 ? required : [];

    return {
      ...base,
      supported: view.kind === "isolated" && probe.ok && warnings.length === 0,
      requestedCapabilities: required,
      capabilities,
      missingCapabilities: required.filter((capability) => !capabilities.includes(capability)),
      warnings
    };
  }

  async runWithProfile(profile: unknown, command: EnvironmentCommand): Promise<EnvironmentRunResult> {
    const report = this.doctor(profile);
    if (!report.supported) {
      return unavailableResult(report.warnings.join(" ") || "Docker isolated backend is unavailable.");
    }
    try {
      return runDocker(profile as EnvironmentProfileView, command);
    } catch (error) {
      return unavailableResult(error instanceof Error ? error.message : "Docker command could not be prepared.");
    }
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
      securityBoundary: "simulated",
      requestedCapabilities: requiredCapabilities,
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

export function resolveExecutionEnvironment(
  profile: unknown,
  registry = SchemaRegistry.load()
): LocalIsolatedExecutionEnvironment | DockerExecutionEnvironment | FakeExecutionEnvironment {
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
  if (!view.environment.inheritByDefault) capabilities.add("environment-scrubbed");
  if (view.limits.maximumProcesses > 0) capabilities.add("process-limits");
  if (view.limits.maximumOutputBytes > 0) capabilities.add("output-limits");
  if (view.kind === "isolated") capabilities.add("process-tree-cancellation");
  return [...capabilities].sort();
}

function probeDocker(view: EnvironmentProfileView): { readonly ok: boolean; readonly warnings: readonly string[] } {
  const backend = view.backend;
  if (!backend) return { ok: false, warnings: ["No Docker backend configuration is present."] };
  const warnings: string[] = [];
  const version = spawnSync("docker", ["version", "--format", "{{.Server.Version}}"], { encoding: "utf8", timeout: 10_000, windowsHide: true });
  if (version.status !== 0 || !version.stdout.trim()) {
    warnings.push("Docker Engine is unavailable.");
    return { ok: false, warnings };
  }
  const image = `${backend.image}@${backend.imageDigest}`;
  const inspect = spawnSync("docker", ["image", "inspect", image, "--format", "{{.Id}}"], { encoding: "utf8", timeout: 10_000, windowsHide: true });
  if (inspect.status !== 0 || !inspect.stdout.trim()) {
    warnings.push("The pinned Docker image is not available locally.");
    return { ok: false, warnings };
  }

  const probeRoot = mkdtempSync(join(tmpdir(), "aicw-docker-probe-"));
  try {
    writeFileSync(join(probeRoot, "host-secret.fixture"), "must-not-be-visible\n", "utf8");
    const script = "const fs=require('node:fs'); if(fs.existsSync('/host-secret.fixture')) process.exit(21); const r=require('node:http').get({host:'1.1.1.1',port:80,path:'/',timeout:500},()=>process.exit(22)); r.on('error',()=>process.exit(0)); r.on('timeout',()=>{r.destroy();process.exit(0)});";
    const result = spawnSync("docker", dockerArgs(view, { executable: "node", args: ["-e", script], cwd: probeRoot, timeoutMs: 5_000, maximumOutputBytes: 2_048 }, probeRoot), {
      encoding: "utf8",
      timeout: 15_000,
      windowsHide: true
    });
    if (result.status !== 0) warnings.push("Docker isolation probe failed for filesystem and network boundaries.");
  } finally {
    rmSync(probeRoot, { recursive: true, force: true });
  }
  return { ok: warnings.length === 0, warnings };
}

function runDocker(view: EnvironmentProfileView, command: EnvironmentCommand): EnvironmentRunResult {
  const timeoutMs = Math.min(command.timeoutMs, view.limits.maximumDurationSeconds * 1_000);
  const result = spawnSync("docker", dockerArgs(view, command, command.cwd), {
    input: command.input,
    encoding: "utf8",
    timeout: timeoutMs,
    windowsHide: true,
    maxBuffer: command.maximumOutputBytes
  });
  const error = result.error ?? null;
  return {
    status: result.status,
    stdout: typeof result.stdout === "string" ? result.stdout : "",
    stderr: typeof result.stderr === "string" ? result.stderr : "",
    timedOut: (error as NodeJS.ErrnoException | null)?.code === "ETIMEDOUT",
    outputTruncated: (error as NodeJS.ErrnoException | null)?.code === "ENOBUFS",
    error
  };
}

function dockerArgs(view: EnvironmentProfileView, command: EnvironmentCommand, mountRoot: string): string[] {
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
  return [
    "run", "--rm", "--init", "--network", "none", "--read-only", "--cap-drop", "ALL",
    "--security-opt", "no-new-privileges", "--pids-limit", String(view.limits.maximumProcesses),
    ...(view.limits.maximumMemoryBytes ? ["--memory", String(view.limits.maximumMemoryBytes)] : []),
    ...(view.limits.maximumCpuUnits ? ["--cpus", String(view.limits.maximumCpuUnits)] : []),
    "--tmpfs", "/tmp:rw,nosuid,nodev", "-v", `${root}:/workspace:rw`, "-w", containerCwd,
    ...envArgs, `${backend.image}@${backend.imageDigest}`, command.executable, ...mappedArgs
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
