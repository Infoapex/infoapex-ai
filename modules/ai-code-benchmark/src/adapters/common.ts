import { createHash } from "node:crypto";
import type { AdapterDoctorReport, AdapterRequest, AdapterResult, AdapterUsage, BoundedProcessResult } from "../types.js";
import { unknownUsage } from "./parse.js";
import { runBoundedProcess } from "./subprocess.js";

export const ADAPTER_VERSION = "bench-adapter.v1";
const DOCTOR_TIMEOUT_MS = 5_000;
const DOCTOR_OUTPUT_BYTES = 32_768;

export async function probeCommand(input: {
  readonly id: string;
  readonly command: readonly string[];
  readonly requiredCapabilities: readonly string[];
  readonly helpArgs: readonly string[];
}): Promise<AdapterDoctorReport> {
  const version = await runBoundedProcess({ command: [...input.command, "--version"], cwd: process.cwd(), timeoutMs: DOCTOR_TIMEOUT_MS, maximumOutputBytes: DOCTOR_OUTPUT_BYTES });
  const help = await runBoundedProcess({ command: [...input.command, ...input.helpArgs], cwd: process.cwd(), timeoutMs: DOCTOR_TIMEOUT_MS, maximumOutputBytes: DOCTOR_OUTPUT_BYTES });
  const helpText = `${help.stdout}\n${help.stderr}`;
  const missingCapabilities = input.requiredCapabilities.filter((capability) => !helpText.includes(capability));
  const executableVersion = version.exitCode === 0 && !version.timedOut && !version.outputTruncated ? redactVersion(firstNonEmptyLine(version.stdout)) : null;
  const unsupported = help.processError !== null || help.exitCode !== 0 || help.timedOut || help.outputTruncated || missingCapabilities.length > 0;
  return {
    id: input.id,
    status: unsupported ? "UNSUPPORTED" : "PASS",
    executable: input.command[0]!,
    executableVersion,
    requiredCapabilities: input.requiredCapabilities,
    missingCapabilities,
    message: unsupported
      ? missingCapabilities.length > 0
        ? `Configured command does not expose required capabilities: ${missingCapabilities.join(", ")}.`
        : "Configured command could not complete the bounded capability probe."
      : "Configured command passed the bounded capability probe."
  };
}

export function unsupportedResult(input: { readonly id: string; readonly parserVersion: string; readonly request: AdapterRequest; readonly message: string; readonly executable?: string | null; readonly executableVersion?: string | null }): AdapterResult {
  const timestamp = new Date().toISOString();
  return {
    status: "UNSUPPORTED",
    message: input.message,
    adapter: { id: input.id, adapterVersion: ADAPTER_VERSION, parserVersion: input.parserVersion, executable: input.executable ?? null, executableVersion: input.executableVersion ?? null },
    execution: { arm: input.request.arm, provider: input.request.provider, model: input.request.model, effort: input.request.effort, permissions: input.request.permissions, configuration: input.request.armConfiguration ?? null, forwardedEnvironment: [] },
    timing: { startedAt: timestamp, completedAt: timestamp, elapsedMs: 0 },
    termination: { exitCode: null, signal: null, timedOut: false, outputTruncated: false },
    output: { rawOutputSha256: createHash("sha256").update("").digest("hex"), capturedBytes: 0, redacted: true },
    usage: unknownUsage()
  };
}

export function normalizedResult(input: {
  readonly id: string;
  readonly parserVersion: string;
  readonly request: AdapterRequest;
  readonly executable: string;
  readonly executableVersion: string | null;
  readonly process: BoundedProcessResult;
  readonly parsed: { readonly valid: boolean; readonly usage: AdapterUsage; readonly model: string | null };
}): AdapterResult {
  const failed = input.process.processError !== null || input.process.timedOut || input.process.outputTruncated || input.process.exitCode !== 0 || !input.parsed.valid;
  const message = input.process.timedOut ? "Adapter process exceeded its configured timeout."
    : input.process.outputTruncated ? "Adapter process exceeded its configured output limit."
    : input.process.processError !== null ? "Adapter process could not be started."
    : input.process.exitCode !== 0 ? `Adapter process exited unsuccessfully with code ${String(input.process.exitCode)}.`
    : !input.parsed.valid ? "Adapter process produced malformed structured output."
    : "Adapter process completed with structured output.";
  return {
    status: failed ? "BLOCKED" : "DONE",
    message,
    adapter: { id: input.id, adapterVersion: ADAPTER_VERSION, parserVersion: input.parserVersion, executable: input.executable, executableVersion: input.executableVersion },
    execution: { arm: input.request.arm, provider: input.request.provider, model: input.parsed.model ?? input.request.model, effort: input.request.effort, permissions: input.request.permissions, configuration: input.request.armConfiguration ?? null, forwardedEnvironment: input.process.forwardedEnvironment },
    timing: { startedAt: input.process.startedAt, completedAt: input.process.completedAt, elapsedMs: input.process.elapsedMs },
    termination: { exitCode: input.process.exitCode, signal: input.process.signal, timedOut: input.process.timedOut, outputTruncated: input.process.outputTruncated },
    output: { rawOutputSha256: input.process.rawOutputSha256, capturedBytes: input.process.capturedBytes, redacted: true },
    usage: input.parsed.usage
  };
}

function firstNonEmptyLine(value: string): string | null { return value.split(/\r?\n/).map((line) => line.trim()).find(Boolean) ?? null; }
function redactVersion(value: string | null): string | null {
  return value?.replace(/\b((?:api[_-]?key|token|secret|password|authorization)\s*[=:])\s*\S+/gi, "$1[REDACTED]") ?? null;
}
