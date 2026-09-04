import type { AdapterDoctorReport, AdapterRequest, AdapterResult, BenchmarkAdapter } from "../types.js";
import { ADAPTER_VERSION, normalizedResult, probeCommand, unsupportedResult } from "./common.js";
import { CODEX_PARSER_VERSION, parseCodexOutput } from "./parse.js";
import { runBoundedProcess } from "./subprocess.js";

const REQUIRED = ["exec", "--json", "--sandbox"] as const;

export class DirectCodexAdapter implements BenchmarkAdapter {
  public readonly id = "direct-codex";
  public constructor(private readonly command: readonly string[]) {}
  public async doctor(): Promise<AdapterDoctorReport> { return probeCommand({ id: this.id, command: this.command, requiredCapabilities: REQUIRED, helpArgs: ["exec", "--help"] }); }
  public async execute(request: AdapterRequest): Promise<AdapterResult> {
    if (request.arm !== "direct" || request.provider !== "codex") return unsupportedResult({ id: this.id, parserVersion: CODEX_PARSER_VERSION, request, executable: this.command[0], message: "direct-codex only supports the direct Codex arm; no fallback was attempted." });
    const doctor = await this.doctor();
    if (doctor.status !== "PASS") return unsupportedResult({ id: this.id, parserVersion: CODEX_PARSER_VERSION, request, executable: this.command[0], executableVersion: doctor.executableVersion, message: doctor.message });
    const args = ["exec", "--json", "--sandbox", request.permissions.sandbox ?? "workspace-write"];
    if (request.model !== null) args.push("--model", request.model);
    if (request.effort !== null) args.push("--config", `model_reasoning_effort=${request.effort}`);
    // `codex exec -` reads the prompt from stdin. Keeping private task text out of
    // argv prevents it from being exposed through process listings while
    // shell:false still keeps every option a fixed argument token.
    args.push("-");
    const process = await runBoundedProcess({ command: [...this.command, ...args], cwd: request.repositoryPath, stdin: request.prompt, timeoutMs: request.limits.timeoutMs, maximumOutputBytes: request.limits.maximumOutputBytes, environmentNames: request.environmentAllowlist });
    return normalizedResult({ id: this.id, parserVersion: CODEX_PARSER_VERSION, request, executable: this.command[0]!, executableVersion: doctor.executableVersion, process, parsed: parseCodexOutput(process.stdout) });
  }
}
export const DIRECT_CODEX_ADAPTER_VERSION = ADAPTER_VERSION;
