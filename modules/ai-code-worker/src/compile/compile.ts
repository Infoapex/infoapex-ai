import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { bindRunAuthorization, type RunAuthorization, type RunIntent } from "../authorization/run-authorization.js";
import { loadProjectConfig } from "../config/project-config.js";
import {
  inspectExecutionEnvironment,
  type ExecutionEnvironmentKind,
  type TrustedLocalAuthorizationInput,
  type TrustedLocalAuthorizationRecord
} from "../execution/environment.js";
import { gitPreflight, type GitPreflightResult } from "../git/preflight.js";
import { freezeManifest, sha256 } from "../manifest/normalize.js";
import { EventLog } from "../persistence/event-log.js";
import { SchemaRegistry } from "../schema/json-schema.js";
import { isPathInside, resolveStateRoot } from "../state/state-root.js";
import { assertSafeWorkerRunId } from "../state/run-id.js";
import { parsePlanMarkdown } from "./plan-parser.js";
import { resolveRoutingProfile } from "../routing/routing-policy.js";

export interface CompileOptions {
  readonly repositoryPath: string;
  readonly planPath: string;
  readonly runId?: string;
  readonly now?: string;
  readonly trustedLocalAuthorization?: TrustedLocalAuthorizationInput;
  /** Real autonomous writers set this flag. Contract-only compile and the
   * deterministic fake harness do not claim that an execution backend exists. */
  readonly requireRunnableExecutionEnvironment?: boolean;
}

export interface CompileReport {
  readonly status: "PASS" | "BLOCKED";
  readonly runId: string | null;
  readonly repository: GitPreflightResult;
  readonly manifestSha256: string | null;
  readonly authorization: RunAuthorization | null;
  readonly state: {
    readonly runRoot: string | null;
    readonly manifestPath: string | null;
    readonly authorizationPath: string | null;
    readonly intentPath: string | null;
    readonly eventLogPath: string | null;
  };
  readonly findings: readonly CompileFinding[];
}

export interface CompileFinding {
  readonly severity: "blocker";
  readonly code: string;
  readonly message: string;
}

export function runCompile(options: CompileOptions): CompileReport {
  const registry = SchemaRegistry.load();
  const repository = gitPreflight(options.repositoryPath);

  if (!repository.ok) {
    return blocked(repository, "GIT_PREFLIGHT_FAILED", repository.reason);
  }

  const planAbsolutePath = resolve(repository.worktreeRoot, options.planPath);

  if (!isPathInside(repository.worktreeRoot, planAbsolutePath) || !existsSync(planAbsolutePath)) {
    return blocked(repository, "PLAN_NOT_FOUND", `Plan not found inside repository: ${options.planPath}`);
  }

  const planText = readFileSync(planAbsolutePath, "utf8");
  const planSha256 = sha256(planText);
  const parsedPlan = (() => {
    try {
      return parsePlanMarkdown(planText);
    } catch (error) {
      return error instanceof Error ? error : new Error(String(error));
    }
  })();

  if (parsedPlan instanceof Error) {
    return blocked(repository, "PLAN_INVALID", parsedPlan.message);
  }

  if (parsedPlan.status !== "accepted") {
    return blocked(repository, "PLAN_NOT_ACCEPTED", `Plan status must be accepted, got ${parsedPlan.status}.`);
  }

  const now = options.now ?? new Date().toISOString();
  const runId = options.runId ?? `run-${sha256(`${planSha256}:${repository.headCommit}`).slice(0, 16)}`;
  try {
    assertSafeWorkerRunId(runId);
  } catch (error) {
    return blocked(repository, "RUN_ID_INVALID", error instanceof Error ? error.message : String(error));
  }
  let routedTasks: readonly unknown[];
  try {
    routedTasks = parsedPlan.body.tasks.map((task) => {
      if (!task || typeof task !== "object") return task;
      const candidate = task as Record<string, unknown>;
      if (typeof candidate.executionProfile !== "string") return task;
      const routing = resolveRoutingProfile(repository.worktreeRoot, candidate.executionProfile);
      if (!routing) {
        throw new Error(`Routing profile '${candidate.executionProfile}' is not configured in .ai-code-worker/routing-policy.json.`);
      }
      return { ...candidate, routing };
    });
  } catch (error) {
    return blocked(repository, "ROUTING_PROFILE_UNAVAILABLE", error instanceof Error ? error.message : String(error));
  }
  const manifest = {
    schemaVersion: "1.0",
    runId,
    graphVersion: 1,
    plan: {
      path: normalizeRelativePath(relative(repository.worktreeRoot, planAbsolutePath)),
      sha256: planSha256,
      status: "accepted"
    },
    base: {
      ref: "HEAD",
      commit: repository.headCommit
    },
    goal: parsedPlan.body.goal,
    tasks: routedTasks,
    globalGates: parsedPlan.body.globalGates,
    budgets: parsedPlan.body.budgets
  };
  const frozenManifest = freezeManifest(manifest, registry);
  const repositoryFingerprint = sha256(`${repository.worktreeRoot}:${repository.gitCommonDir}:${repository.headCommit}`);
  const executionProfile = loadExecutionProfile(repository.worktreeRoot);
  const projectConfig = loadProjectConfig(repository.worktreeRoot);
  const executionPolicy = projectConfig?.executionEnvironment ?? {
    defaultProfile: "isolated" as const,
    allowTrustedLocal: false
  };
  let executionEnvironmentKind: ExecutionEnvironmentKind;
  let trustedLocalAuthorization: TrustedLocalAuthorizationRecord | null = null;

  try {
    const inspection = inspectExecutionEnvironment(
      executionProfile,
      executionPolicy,
      options.trustedLocalAuthorization,
      registry
    );
    executionEnvironmentKind = inspection.report.kind;
    trustedLocalAuthorization = inspection.authorization;

    const policyMismatch = inspection.findings.find(
      (finding) => finding.code === "EXECUTION_PROFILE_KIND_MISMATCH" || finding.code === "TRUSTED_LOCAL_NOT_AUTHORIZED"
    );
    if (policyMismatch || (options.requireRunnableExecutionEnvironment && !inspection.runnable)) {
      const finding = inspection.findings[0];
      return blocked(
        repository,
        finding?.code ?? "ENVIRONMENT_UNAVAILABLE",
        finding?.message ?? "The configured execution environment is unavailable."
      );
    }
  } catch (error) {
    return blocked(
      repository,
      "EXECUTION_PROFILE_INVALID",
      error instanceof Error ? error.message : String(error)
    );
  }
  const intent = buildRunIntent({
    runId,
    planPath: manifest.plan.path,
    planSha256,
    baseCommit: repository.headCommit,
    repositoryFingerprint,
    budgets: manifest.budgets,
    executionEnvironmentKind,
    trustedLocalAuthorization,
    now
  });
  const authorization = bindRunAuthorization({
    authorizationId: `auth-${sha256(`${runId}:${frozenManifest.sha256}`).slice(0, 16)}`,
    intent,
    manifest,
    executionProfile,
    repositoryFingerprint,
    issuedAt: now,
    registry
  });
  const stateRoot = resolveStateRoot({ repoRoot: repository.worktreeRoot });
  const runRoot = join(stateRoot.path, "runs", runId);
  const manifestPath = join(runRoot, "manifest.json");
  const authorizationPath = join(runRoot, "authorization.json");
  const intentPath = join(runRoot, "run-intent.json");
  const eventLog = new EventLog(join(runRoot, "events.jsonl"), registry);
  const existing = readExistingRun({
    runId,
    repository,
    manifestSha256: frozenManifest.sha256,
    authorization,
    runRoot,
    manifestPath,
    authorizationPath,
    intentPath,
    eventLogPath: eventLog.path,
    registry
  });

  if (existing) {
    return existing;
  }

  mkdirSync(runRoot, { recursive: true });
  writeJson(intentPath, intent);
  writeJson(manifestPath, manifest);
  writeJson(authorizationPath, authorization);
  eventLog.append({
    eventId: `${runId}-0000-run-created`,
    runId,
    type: "run.created",
    createdAt: now,
    payload: { baseCommit: repository.headCommit }
  });
  eventLog.append({
    eventId: `${runId}-0001-intent-created`,
    runId,
    type: "run.intent-created",
    createdAt: now,
    payload: { intentId: intent.intentId }
  });
  eventLog.append({
    eventId: `${runId}-0002-manifest-compiled`,
    runId,
    type: "manifest.compiled",
    createdAt: now,
    payload: { planSha256 }
  });
  eventLog.append({
    eventId: `${runId}-0003-manifest-frozen`,
    runId,
    type: "manifest.frozen",
    createdAt: now,
    payload: { manifestSha256: frozenManifest.sha256 }
  });
  eventLog.append({
    eventId: `${runId}-0004-authorization-bound`,
    runId,
    type: "authorization.bound",
    createdAt: now,
    payload: { authorizationId: authorization.authorizationId }
  });

  return {
    status: "PASS",
    runId,
    repository,
    manifestSha256: frozenManifest.sha256,
    authorization,
    state: {
      runRoot,
      manifestPath,
      authorizationPath,
      intentPath,
      eventLogPath: eventLog.path
    },
    findings: []
  };
}

function buildRunIntent(input: {
  readonly runId: string;
  readonly planPath: string;
  readonly planSha256: string;
  readonly baseCommit: string;
  readonly repositoryFingerprint: string;
  readonly budgets: Record<string, unknown>;
  readonly executionEnvironmentKind: ExecutionEnvironmentKind;
  readonly trustedLocalAuthorization: TrustedLocalAuthorizationRecord | null;
  readonly now: string;
}): RunIntent {
  const maximumRunMinutes = Number(input.budgets.maximumRunMinutes);

  return {
    schemaVersion: "1.0",
    intentId: `intent-${sha256(`${input.runId}:${input.planSha256}`).slice(0, 16)}`,
    runId: input.runId,
    planPath: input.planPath,
    planSha256: input.planSha256,
    baseRef: "HEAD",
    baseCommit: input.baseCommit,
    repositoryFingerprint: input.repositoryFingerprint,
    requestedCapabilities: [
      "write-worktree",
      input.executionEnvironmentKind === "isolated" ? "run-isolated-tests" : "run-trusted-local-tests",
      "create-local-commits"
    ],
    forbiddenCapabilities: ["push", "deploy", "network-write"],
    approvalMode: "never",
    executionEnvironmentKind: input.executionEnvironmentKind,
    ...(input.trustedLocalAuthorization !== null
      ? { trustedLocalAuthorization: input.trustedLocalAuthorization }
      : {}),
    limits: {
      maximumRunMinutes,
      maximumAgentInvocations: Number(input.budgets.maximumAgentInvocations),
      maximumInputUncachedTokens: Number(input.budgets.maximumRunInputUncachedTokens),
      maximumCacheReadTokens: Number(input.budgets.maximumRunCacheReadTokens),
      maximumCacheWriteTokens: Number(input.budgets.maximumRunCacheWriteTokens),
      maximumOutputTokens: Number(input.budgets.maximumRunOutputTokens),
      maximumCostUsd: typeof input.budgets.maximumRunCostUsd === "number" ? input.budgets.maximumRunCostUsd : null
    },
    createdAt: input.now,
    expiresAt: new Date(Date.parse(input.now) + maximumRunMinutes * 60_000).toISOString()
  };
}

export function loadExecutionProfile(worktreeRoot: string): unknown {
  const localPath = join(worktreeRoot, ".ai-code-worker", "execution-environment.example.json");
  const fallbackPath = join(packageRoot(), "templates", "project", ".ai-code-worker", "execution-environment.example.json");

  return JSON.parse(readFileSync(existsSync(localPath) ? localPath : fallbackPath, "utf8"));
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function normalizeRelativePath(path: string): string {
  return path.replaceAll("\\", "/");
}

function packageRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
}

function readExistingRun(input: {
  readonly runId: string;
  readonly repository: GitPreflightResult;
  readonly manifestSha256: string;
  readonly authorization: RunAuthorization;
  readonly runRoot: string;
  readonly manifestPath: string;
  readonly authorizationPath: string;
  readonly intentPath: string;
  readonly eventLogPath: string;
  readonly registry: SchemaRegistry;
}): CompileReport | null {
  if (!existsSync(input.eventLogPath)) {
    return null;
  }

  if (!existsSync(input.manifestPath) || !existsSync(input.authorizationPath) || !existsSync(input.intentPath)) {
    return blocked(input.repository, "RUN_STATE_CONFLICT", `Run ${input.runId} has an event log but missing frozen state files.`);
  }

  let existingManifest: unknown;
  let existingAuthorization: RunAuthorization;
  try {
    existingManifest = JSON.parse(readFileSync(input.manifestPath, "utf8")) as unknown;
    existingAuthorization = JSON.parse(readFileSync(input.authorizationPath, "utf8")) as RunAuthorization;
    const existingIntent = JSON.parse(readFileSync(input.intentPath, "utf8")) as unknown;
    input.registry.assertValid("manifest.schema.json", existingManifest);
    input.registry.assertValid("run-authorization.schema.json", existingAuthorization);
    input.registry.assertValid("run-intent.schema.json", existingIntent);
  } catch (error) {
    return blocked(
      input.repository,
      "RUN_STATE_CONFLICT",
      `Run ${input.runId} has unreadable or schema-invalid frozen state: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  const existingManifestSha256 = freezeManifest(existingManifest, input.registry).sha256;

  if (
    existingManifestSha256 !== input.manifestSha256 ||
    existingAuthorization.manifestSha256 !== input.manifestSha256 ||
    canonicalAuthorizationBinding(existingAuthorization) !== canonicalAuthorizationBinding(input.authorization)
  ) {
    return blocked(input.repository, "RUN_STATE_CONFLICT", `Run ${input.runId} already exists with different frozen state.`);
  }

  return {
    status: "PASS",
    runId: input.runId,
    repository: input.repository,
    manifestSha256: input.manifestSha256,
    authorization: existingAuthorization,
    state: {
      runRoot: input.runRoot,
      manifestPath: input.manifestPath,
      authorizationPath: input.authorizationPath,
      intentPath: input.intentPath,
      eventLogPath: input.eventLogPath
    },
    findings: []
  };
}

function canonicalAuthorizationBinding(authorization: RunAuthorization): string {
  return JSON.stringify({
    schemaVersion: authorization.schemaVersion,
    authorizationId: authorization.authorizationId,
    runId: authorization.runId,
    repositoryFingerprint: authorization.repositoryFingerprint,
    planSha256: authorization.planSha256,
    manifestSha256: authorization.manifestSha256,
    baseCommit: authorization.baseCommit,
    graphVersion: authorization.graphVersion,
    executionEnvironment: authorization.executionEnvironment,
    trustedLocalAuthorization: authorization.trustedLocalAuthorization ?? null,
    allowedCapabilities: authorization.allowedCapabilities,
    forbiddenCapabilities: authorization.forbiddenCapabilities,
    approvalMode: authorization.approvalMode,
    limits: authorization.limits
  });
}

function blocked(repository: GitPreflightResult, code: string, message: string): CompileReport {
  return {
    status: "BLOCKED",
    runId: null,
    repository,
    manifestSha256: null,
    authorization: null,
    state: {
      runRoot: null,
      manifestPath: null,
      authorizationPath: null,
      intentPath: null,
      eventLogPath: null
    },
    findings: [{ severity: "blocker", code, message }]
  };
}
