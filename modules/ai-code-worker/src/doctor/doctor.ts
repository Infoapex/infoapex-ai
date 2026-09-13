import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadProjectConfig, type ProjectConfig } from "../config/project-config.js";
import { ClaudeCliAdapter, type ClaudeCliAdapterConfig, type ClaudeDoctorReport } from "../engines/claude-cli.js";
import { CodexCliAdapter, type CodexCliAdapterConfig, type CodexDoctorReport } from "../engines/codex-cli.js";
import { resolveExecutionEnvironment, type EnvironmentCapabilityReport } from "../execution/environment.js";
import { gitPreflight, type GitPreflightResult } from "../git/preflight.js";
import { evaluateSyncRootPolicy, type SyncRootPolicyResult } from "../git/sync-root.js";
import { resolveStateRoot, type ResolvedStateRoot } from "../state/state-root.js";

export interface DoctorOptions {
  readonly repositoryPath: string;
  readonly engine?: "fake" | "codex" | "claude";
  readonly claudeExecutable?: string;
  readonly codexExecutable?: string;
  readonly claudeModel?: string;
  readonly codexModel?: string;
  readonly claudePermissionMode?: "default" | "auto" | "plan" | "acceptEdits" | "bypassPermissions" | "dontAsk";
  readonly claudeBareMode?: boolean;
  readonly claudeDangerouslySkipPermissions?: boolean;
  readonly codexSandboxMode?: "workspace-write" | "danger-full-access";
}

export interface DoctorReport {
  readonly status: "PASS" | "WARN" | "BLOCKED";
  readonly repository: GitPreflightResult;
  readonly stateRoot: ResolvedStateRoot | null;
  readonly syncRoot: SyncRootPolicyResult | null;
  readonly executionEnvironment: EnvironmentCapabilityReport | null;
  readonly engineDoctor: CodexDoctorReport | ClaudeDoctorReport | null;
  readonly findings: readonly DoctorFinding[];
}

export interface DoctorFinding {
  readonly severity: "warning" | "blocker";
  readonly code: string;
  readonly message: string;
}

export function runDoctor(options: DoctorOptions): DoctorReport {
  const repository = gitPreflight(options.repositoryPath);
  const findings: DoctorFinding[] = [];

  if (!repository.ok) {
    return {
      status: "BLOCKED",
      repository,
      stateRoot: null,
      syncRoot: null,
      executionEnvironment: null,
      engineDoctor: null,
      findings: [
        {
          severity: "blocker",
          code: "GIT_PREFLIGHT_FAILED",
          message: repository.reason
        }
      ]
    };
  }

  const config = loadProjectConfig(repository.worktreeRoot);
  const executionProfile =
    readOptionalJson(join(repository.worktreeRoot, ".ai-code-worker", "execution-environment.example.json")) ??
    readOptionalJson(join(packageRoot(), "templates", "project", ".ai-code-worker", "execution-environment.example.json"));
  const maximumParallelWriters = config?.maximumParallelWriters ?? 1;
  const syncRootPolicy = config?.syncRootPolicy ?? { sequentialWriter: "warn", parallelWriters: "block" };
  const stateRoot = resolveStateRoot({
    repoRoot: repository.worktreeRoot,
    configuredStateRoot: config?.stateRoot ?? null
  });
  const syncRoot = evaluateSyncRootPolicy({
    gitCommonDir: repository.gitCommonDir,
    maximumParallelWriters,
    policy: syncRootPolicy
  });
  const executionEnvironment = executionProfile ? resolveExecutionEnvironment(executionProfile).doctor(executionProfile) : null;
  const engineDoctor = options.engine === "codex"
    ? new CodexCliAdapter({
        ...defaultCodexConfig(),
        ...codexAdapterConfigFromProject(config),
        ...(options.codexExecutable !== undefined ? { executable: options.codexExecutable } : {}),
        ...(options.codexModel !== undefined ? { defaultModel: options.codexModel } : {}),
        ...(options.codexSandboxMode !== undefined ? { sandboxMode: options.codexSandboxMode } : {})
      }).doctor()
    : options.engine === "claude"
    ? new ClaudeCliAdapter({
        ...defaultClaudeConfig(),
        ...claudeAdapterConfigFromProject(config),
        ...(options.claudeExecutable !== undefined ? { executable: options.claudeExecutable } : {}),
        ...(options.claudeModel !== undefined ? { defaultModel: options.claudeModel } : {}),
        ...(options.claudePermissionMode !== undefined ? { permissionMode: options.claudePermissionMode } : {}),
        ...(options.claudeBareMode !== undefined ? { bareMode: options.claudeBareMode } : {}),
        ...(options.claudeDangerouslySkipPermissions !== undefined ? { dangerouslySkipPermissions: options.claudeDangerouslySkipPermissions } : {})
      }).doctor()
    : null;

  if (stateRoot.insideRepository) {
    findings.push({
      severity: "blocker",
      code: "STATE_ROOT_INSIDE_REPOSITORY",
      message: "Operational state root must not live inside the consumer repository."
    });
  }

  if (syncRoot.verdict === "block") {
    findings.push({
      severity: "blocker",
      code: "SYNC_ROOT_BLOCKED",
      message: syncRoot.message
    });
  } else if (syncRoot.verdict === "warn") {
    findings.push({
      severity: "warning",
      code: "SYNC_ROOT_WARNING",
      message: syncRoot.message
    });
  }

  if (!executionEnvironment?.supported) {
    findings.push({
      severity: "blocker",
      code: "ENVIRONMENT_UNAVAILABLE",
      message: "The configured execution environment does not satisfy isolated writer requirements."
    });
  }

  if ((options.engine === "codex" || options.engine === "claude") && !executionEnvironment?.providerSupported) {
    findings.push({
      severity: "blocker",
      code: "PROVIDER_ENVIRONMENT_UNAVAILABLE",
      message: "The configured execution environment does not provide an isolated provider boundary for the selected engine."
    });
  }

  if (engineDoctor?.status === "BLOCKED") {
    for (const finding of engineDoctor.findings) {
      findings.push(finding);
    }
  }

  const status = findings.some((finding) => finding.severity === "blocker")
    ? "BLOCKED"
    : findings.length > 0
      ? "WARN"
      : "PASS";

  return {
    status,
    repository,
    stateRoot,
    syncRoot,
    executionEnvironment,
    engineDoctor,
    findings
  };
}

export function defaultCodexConfig(): CodexCliAdapterConfig {
  return {
    // Versions are discovered dynamically. The help and behavioral smoke tests below
    // are the fail-closed compatibility gate; projects may still opt into an explicit
    // testedVersionRanges override when they need a narrower policy.
    requiresCapabilitySmokeTest: true,
    // The stable profile must never widen the provider sandbox by default. A
    // local pilot may opt into a broader mode explicitly and must record it.
    sandboxMode: "workspace-write"
  };
}

export function defaultClaudeConfig(): ClaudeCliAdapterConfig {
  return {
    requiresCapabilitySmokeTest: true
  };
}

function codexAdapterConfigFromProject(config: ProjectConfig | null): Partial<CodexCliAdapterConfig> {
  const source = config?.adapters?.codex;

  return {
    ...(source?.executable !== undefined ? { executable: source.executable } : {}),
    ...(source?.model !== undefined ? { defaultModel: source.model } : {}),
    ...(source?.reasoningEffort !== undefined ? { reasoningEffort: source.reasoningEffort } : {}),
    ...(source?.sandboxMode !== undefined ? { sandboxMode: source.sandboxMode } : {}),
    ...(source?.timeoutSeconds !== undefined ? { idleTimeoutMs: source.timeoutSeconds * 1000 } : {}),
    ...(source?.idleTimeoutSeconds !== undefined ? { idleTimeoutMs: source.idleTimeoutSeconds * 1000 } : {}),
    ...(source?.maximumRuntimeSeconds !== undefined ? { maximumRuntimeMs: source.maximumRuntimeSeconds * 1000 } : {}),
    ...(source?.maximumRepeatedProgressEvents !== undefined ? { maximumRepeatedProgressEvents: source.maximumRepeatedProgressEvents } : {}),
    ...(source?.maximumOutputBytes !== undefined ? { maximumOutputBytes: source.maximumOutputBytes } : {}),
    ...(source?.testedVersionRanges !== undefined ? { testedVersionRanges: source.testedVersionRanges } : {})
  };
}

function claudeAdapterConfigFromProject(config: ProjectConfig | null): Partial<ClaudeCliAdapterConfig> {
  const source = config?.adapters?.claude;

  return {
    ...(source?.executable !== undefined ? { executable: source.executable } : {}),
    ...(source?.model !== undefined ? { defaultModel: source.model } : {}),
    ...(source?.permissionMode !== undefined ? { permissionMode: source.permissionMode } : {}),
    ...(source?.allowedTools !== undefined ? { allowedTools: source.allowedTools } : {}),
    ...(source?.bareMode !== undefined ? { bareMode: source.bareMode } : {}),
    ...(source?.dangerouslySkipPermissions !== undefined ? { dangerouslySkipPermissions: source.dangerouslySkipPermissions } : {}),
    ...(source?.timeoutSeconds !== undefined ? { idleTimeoutMs: source.timeoutSeconds * 1000 } : {}),
    ...(source?.idleTimeoutSeconds !== undefined ? { idleTimeoutMs: source.idleTimeoutSeconds * 1000 } : {}),
    ...(source?.maximumRuntimeSeconds !== undefined ? { maximumRuntimeMs: source.maximumRuntimeSeconds * 1000 } : {}),
    ...(source?.maximumRepeatedProgressEvents !== undefined ? { maximumRepeatedProgressEvents: source.maximumRepeatedProgressEvents } : {}),
    ...(source?.maximumOutputBytes !== undefined ? { maximumOutputBytes: source.maximumOutputBytes } : {}),
    ...(source?.testedVersionRanges !== undefined ? { testedVersionRanges: source.testedVersionRanges } : {})
  };
}

function readOptionalJson(path: string): unknown | null {
  if (!existsSync(path)) {
    return null;
  }

  return JSON.parse(readFileSync(path, "utf8"));
}

function packageRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
}
