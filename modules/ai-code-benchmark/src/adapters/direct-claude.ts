import type { AdapterDoctorReport, AdapterRequest, AdapterResult, BenchmarkAdapter } from "../types.js";
import { ADAPTER_VERSION, normalizedResult, probeCommand, unsupportedResult } from "./common.js";
import { CLAUDE_PARSER_VERSION, parseClaudeOutput } from "./parse.js";
import { runBoundedProcess } from "./subprocess.js";

const REQUIRED = ["-p", "--output-format", "--permission-mode"] as const;

export class DirectClaudeAdapter implements BenchmarkAdapter {
  public readonly id = "direct-claude";
  public constructor(private readonly command: readonly string[]) {}
  public async doctor(): Promise<AdapterDoctorReport> { return probeCommand({ id: this.id, command: this.command, requiredCapabilities: REQUIRED, helpArgs: ["-p", "--help"] }); }
  public async execute(request: AdapterRequest): Promise<AdapterResult> {
    if (request.arm !== "direct" || request.provider !== "claude") return unsupportedResult({ id: this.id, parserVersion: CLAUDE_PARSER_VERSION, request, executable: this.command[0], message: "direct-claude only supports the direct Claude arm; no fallback was attempted." });
    const doctor = await this.doctor();
    if (doctor.status !== "PASS") return unsupportedResult({ id: this.id, parserVersion: CLAUDE_PARSER_VERSION, request, executable: this.command[0], executableVersion: doctor.executableVersion, message: doctor.message });
    const args = ["-p", "--output-format", "json", "--permission-mode", request.permissions.mode ?? "dontAsk"];
    if (request.model !== null) args.push("--model", request.model);
    if (request.effort !== null) args.push("--effort", request.effort);
    if (request.permissions.allowedTools.length > 0) args.push("--allowedTools", request.permissions.allowedTools.join(","));
    const process = await runBoundedProcess({ command: [...this.command, ...args], cwd: request.repositoryPath, stdin: request.prompt, timeoutMs: request.limits.timeoutMs, maximumOutputBytes: request.limits.maximumOutputBytes, environmentNames: request.environmentAllowlist });
    return normalizedResult({ id: this.id, parserVersion: CLAUDE_PARSER_VERSION, request, executable: this.command[0]!, executableVersion: doctor.executableVersion, process, parsed: parseClaudeOutput(process.stdout) });
  }
}
export const DIRECT_CLAUDE_ADAPTER_VERSION = ADAPTER_VERSION;
