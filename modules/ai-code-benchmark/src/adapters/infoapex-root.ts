import { existsSync, readFileSync } from "node:fs";
import type { AdapterDoctorReport, AdapterRequest, AdapterResult, BenchmarkAdapter } from "../types.js";
import { ADAPTER_VERSION, normalizedResult, probeCommand, unsupportedResult } from "./common.js";
import { INFOAPEX_PARSER_VERSION, parseInfoapexOutput } from "./parse.js";
import { runBoundedProcess } from "./subprocess.js";
import { assertContained, canonicalPath, containedPath } from "../security/paths.js";

const REQUIRED = ["run", "--repo", "--plan", "--engine"] as const;

/** Invokes the bundle root CLI only. It reads public JSON configuration; it never imports worker/control code. */
export class InfoapexRootAdapter implements BenchmarkAdapter {
  public readonly id = "infoapex-root";
  public constructor(private readonly command: readonly string[]) {}
  public async doctor(): Promise<AdapterDoctorReport> { return probeCommand({ id: this.id, command: this.command, requiredCapabilities: REQUIRED, helpArgs: ["--help"] }); }
  public async execute(request: AdapterRequest): Promise<AdapterResult> {
    if (request.arm === "direct") return unsupportedResult({ id: this.id, parserVersion: INFOAPEX_PARSER_VERSION, request, executable: this.command[0], message: "infoapex-root does not implement the direct arm; no fallback was attempted." });
    const configuration = verifyPublicArmConfiguration(request);
    if (configuration !== null) return unsupportedResult({ id: this.id, parserVersion: INFOAPEX_PARSER_VERSION, request, executable: this.command[0], message: configuration });
    if (!request.orchestrationPlanPath) return unsupportedResult({ id: this.id, parserVersion: INFOAPEX_PARSER_VERSION, request, executable: this.command[0], message: "The Infoapex public root adapter requires an evaluator-produced orchestration plan path." });
    const planError = verifyEvaluatorPlan(request);
    if (planError !== null) return unsupportedResult({ id: this.id, parserVersion: INFOAPEX_PARSER_VERSION, request, executable: this.command[0], message: planError });
    const doctor = await this.doctor();
    if (doctor.status !== "PASS") return unsupportedResult({ id: this.id, parserVersion: INFOAPEX_PARSER_VERSION, request, executable: this.command[0], executableVersion: doctor.executableVersion, message: doctor.message });
    const process = await runBoundedProcess({
      command: [...this.command, "run", "--repo", request.repositoryPath, "--plan", request.orchestrationPlanPath, "--engine", request.provider],
      cwd: request.repositoryPath,
      timeoutMs: request.limits.timeoutMs,
      maximumOutputBytes: request.limits.maximumOutputBytes,
      environmentNames: request.environmentAllowlist
    });
    const normalized = normalizedResult({ id: this.id, parserVersion: INFOAPEX_PARSER_VERSION, request, executable: this.command[0]!, executableVersion: doctor.executableVersion, process, parsed: parseInfoapexOutput(process.stdout) });
    if (normalized.status !== "DONE") return normalized;

    const materialization = await materializeWorkerCommits(process.stdout, request);
    if (materialization.error !== null) return { ...normalized, status: "BLOCKED", message: materialization.error };
    return materialization.count === 0
      ? normalized
      : { ...normalized, message: `Adapter process completed and materialized ${materialization.count} worker commit(s) into the evaluator workspace.` };
  }
}

async function materializeWorkerCommits(output: string, request: AdapterRequest): Promise<{ readonly count: number; readonly error: string | null }> {
  let value: unknown;
  try { value = JSON.parse(output); }
  catch { return { count: 0, error: null }; }
  if (!record(value)) return { count: 0, error: null };
  const body = record(value.body) ? value.body : value;
  if (!Object.prototype.hasOwnProperty.call(body, "taskCommits")) return { count: 0, error: null };
  if (!record(body.taskCommits) || !Array.isArray(body.executedTasks)) return { count: 0, error: "Infoapex reported task commits in an invalid public result envelope." };

  const commits: string[] = [];
  for (const taskId of body.executedTasks) {
    if (typeof taskId !== "string") return { count: 0, error: "Infoapex reported a non-string executed task identifier." };
    const commit = body.taskCommits[taskId];
    if (typeof commit !== "string" || !/^[a-f0-9]{40,64}$/u.test(commit)) return { count: 0, error: `Infoapex did not report a valid commit for executed task ${taskId}.` };
    commits.push(commit);
  }
  if (commits.length === 0) return { count: 0, error: null };

  const applied = await runBoundedProcess({
    command: ["git", "cherry-pick", "--no-commit", ...commits],
    cwd: request.repositoryPath,
    timeoutMs: Math.min(request.limits.timeoutMs, 15_000),
    maximumOutputBytes: Math.min(request.limits.maximumOutputBytes, 65_536)
  });
  if (applied.processError !== null || applied.timedOut || applied.outputTruncated || applied.exitCode !== 0) {
    return { count: 0, error: "Infoapex completed, but its worker commits could not be materialized safely in the evaluator workspace." };
  }
  return { count: commits.length, error: null };
}

function record(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }

function verifyEvaluatorPlan(request: AdapterRequest): string | null {
  try {
    const repository = canonicalPath(request.repositoryPath);
    const planPath = assertContained(repository, request.orchestrationPlanPath!);
    const markdown = readFileSync(planPath, "utf8");
    if (!/^---\r?\n[\s\S]*?\bstatus:\s*accepted\s*\r?\n[\s\S]*?---/u.test(markdown)) return "The evaluator-produced worker plan is not accepted Markdown.";
    const match = /```(?:json\s+)?ai-code-worker-plan\r?\n(?<json>[\s\S]*?)\r?\n```/u.exec(markdown);
    if (!match?.groups?.json) return "The evaluator-produced worker plan has no ai-code-worker-plan block.";
    const body = JSON.parse(match.groups.json) as { workerContractVersion?: unknown; goal?: unknown; tasks?: readonly { role?: unknown; acceptanceCriteria?: readonly unknown[]; traceability?: { acceptanceCriteria?: readonly { text?: unknown }[] } }[] };
    const task = body.tasks?.[0];
    if (body.workerContractVersion !== "1.1" || body.goal !== request.prompt || body.tasks?.length !== 1 || task?.role !== request.prompt || task.acceptanceCriteria?.[0] !== request.prompt || task.traceability?.acceptanceCriteria?.[0]?.text !== request.prompt) return "The worker v1.1 plan does not preserve the exact frozen generic task prompt and criteria.";
    return null;
  } catch {
    return "The evaluator-produced orchestration plan is invalid or outside the isolated repository.";
  }
}

function verifyPublicArmConfiguration(request: AdapterRequest): string | null {
  const declared = request.armConfiguration;
  if (!declared) return "Infoapex arms require an explicit public context configuration declaration.";
  if (request.arm === "orchestrated-no-icm" && (declared.contextProvider !== "none" || declared.contextPackageMode !== "off")) return "The orchestrated-no-icm arm must explicitly declare contextProvider none and contextPackage.mode off.";
  if ((request.arm === "full-icm" || request.arm === "candidate") && (declared.contextProvider !== "ai-code-control" || declared.contextPackageMode === "off")) return "The full-icm and candidate arms require ai-code-control and an enabled public context-package mode.";
  if (request.arm === "candidate" && (!declared.candidateCapability || declared.candidateCapability.trim().length === 0)) return "The candidate arm requires one declared candidate capability.";

  try {
    const repository = canonicalPath(request.repositoryPath);
    const configPath = containedPath(repository, ".ai-code-worker", "config.json");
    if (!existsSync(configPath)) return "The isolated repository does not contain the required public worker configuration.";
    const config = JSON.parse(readFileSync(configPath, "utf8")) as { contextProvider?: unknown; contextPackage?: { mode?: unknown } };
    const actualProvider = config.contextProvider;
    const actualMode = config.contextPackage?.mode;
    if (actualProvider !== declared.contextProvider || actualMode !== declared.contextPackageMode) return "The public worker configuration does not match the declared benchmark arm configuration.";
    return null;
  } catch {
    return "The public worker configuration is not valid JSON.";
  }
}

export const INFOAPEX_ROOT_ADAPTER_VERSION = ADAPTER_VERSION;
