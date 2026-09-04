import { createHash } from "node:crypto";
import type { AdapterDoctorReport, AdapterRequest, AdapterResult, BenchmarkAdapter, BoundedProcessResult } from "../types.js";
import { ADAPTER_VERSION, normalizedResult, unsupportedResult } from "./common.js";
import { CLAUDE_PARSER_VERSION, parseClaudeOutput } from "./parse.js";

export type FakeAdapterScenario = "done" | "blocked" | "timeout" | "malformed" | "unsupported";

/** Deterministic in-process adapter for harness CI; it is never a provider-value observation. */
export class FakeAdapter implements BenchmarkAdapter {
  public readonly id = "fake";
  public constructor(private readonly scenario: FakeAdapterScenario = "done") {}
  public async doctor(): Promise<AdapterDoctorReport> { return { id: this.id, status: "PASS", executable: "fake", executableVersion: "fake-cli.v1", requiredCapabilities: [], missingCapabilities: [], message: "Deterministic fake adapter is available." }; }
  public async execute(request: AdapterRequest): Promise<AdapterResult> {
    if (this.scenario === "unsupported") return unsupportedResult({ id: this.id, parserVersion: "fake-result.v1", request, executable: "fake", executableVersion: "fake-cli.v1", message: "Deterministic fake scenario declares this arm unsupported." });
    const stdout = this.scenario === "malformed" ? "not-json" : JSON.stringify({ result: "fake", model: request.model ?? "fake-model", usage: { input_tokens: request.seed, cache_read_input_tokens: 2, cache_creation_input_tokens: 3, output_tokens: 5 }, total_cost_usd: 0 });
    const now = new Date().toISOString();
    const process: BoundedProcessResult = { startedAt: now, completedAt: now, elapsedMs: 0, exitCode: this.scenario === "blocked" ? 1 : 0, signal: null, timedOut: this.scenario === "timeout", outputTruncated: false, stdout, stderr: "", processError: null, rawOutputSha256: createHash("sha256").update(stdout).update("\n").digest("hex"), capturedBytes: Buffer.byteLength(stdout), forwardedEnvironment: [] };
    return normalizedResult({ id: this.id, parserVersion: "fake-result.v1", request, executable: "fake", executableVersion: "fake-cli.v1", process, parsed: parseClaudeOutput(stdout) });
  }
}
export const FAKE_ADAPTER_VERSION = ADAPTER_VERSION;
