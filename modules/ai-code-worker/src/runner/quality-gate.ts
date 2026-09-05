import { spawn, spawnSync } from "node:child_process";
import { redactText } from "./redaction.js";

export interface CommandSpec {
  readonly id: string;
  readonly executable: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly timeoutMs: number;
  readonly maximumOutputBytes: number;
  readonly env?: Readonly<Record<string, string>>;
  readonly linkedDirectories?: readonly LinkedDirectorySpec[];
}

export interface LinkedDirectorySpec {
  readonly from: string;
  readonly to: string;
}

export type GateFailureClass = "deterministic" | "infrastructure";

export interface QualityGateResult {
  readonly id: string;
  readonly executable: string;
  readonly args: readonly string[];
  readonly exitCode: number | null;
  readonly durationMs: number;
  readonly timedOut: boolean;
  readonly outputTruncated: boolean;
  readonly redacted: boolean;
  readonly outputSha256: string;
  readonly failureClass: GateFailureClass | null;
}

export function runQualityGate(command: CommandSpec): Promise<QualityGateResult> {
  const startedAt = Date.now();

  return new Promise((resolve) => {
    const child = spawn(command.executable, command.args, {
      cwd: command.cwd,
      env: runtimeEnvironment(command.env),
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true
    });
    const chunks: Buffer[] = [];
    let outputBytes = 0;
    let outputTruncated = false;
    let timedOut = false;
    let settled = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => {
        if (!settled) {
          child.kill("SIGKILL");
        }
      }, 100).unref();
    }, command.timeoutMs);

    const collect = (chunk: Buffer) => {
      if (outputBytes >= command.maximumOutputBytes) {
        outputTruncated = true;
        return;
      }

      const remaining = command.maximumOutputBytes - outputBytes;
      const accepted = chunk.length > remaining ? chunk.subarray(0, remaining) : chunk;
      chunks.push(accepted);
      outputBytes += accepted.length;
      outputTruncated ||= accepted.length < chunk.length;
    };

    child.stdout.on("data", collect);
    child.stderr.on("data", collect);
    child.on("error", () => {
      clearTimeout(timeout);
      settled = true;
      const redacted = redactText(Buffer.concat(chunks).toString("utf8"));
      resolve({
        id: command.id,
        executable: command.executable,
        args: command.args,
        exitCode: null,
        durationMs: Date.now() - startedAt,
        timedOut,
        outputTruncated,
        redacted: redacted.redacted,
        outputSha256: redacted.sha256,
        failureClass: "infrastructure"
      });
    });
    child.on("close", (exitCode) => {
      clearTimeout(timeout);
      settled = true;
      const redacted = redactText(Buffer.concat(chunks).toString("utf8"));
      const failureClass = timedOut ? "infrastructure" : exitCode === 0 ? null : "deterministic";

      resolve({
        id: command.id,
        executable: command.executable,
        args: command.args,
        exitCode,
        durationMs: Date.now() - startedAt,
        timedOut,
        outputTruncated,
        redacted: redacted.redacted,
        outputSha256: redacted.sha256,
        failureClass
      });
    });
  });
}

export function runQualityGateSync(command: CommandSpec): QualityGateResult {
  const startedAt = Date.now();
  const result = spawnSync(command.executable, command.args, {
    cwd: command.cwd,
    env: runtimeEnvironment(command.env),
    shell: false,
    encoding: "buffer",
    maxBuffer: command.maximumOutputBytes,
    stdio: ["ignore", "pipe", "pipe"],
    timeout: command.timeoutMs,
    windowsHide: true
  });
  const stdout = result.stdout instanceof Buffer ? result.stdout : Buffer.from(result.stdout ?? "");
  const stderr = result.stderr instanceof Buffer ? result.stderr : Buffer.from(result.stderr ?? "");
  const output = Buffer.concat([stdout, stderr]);
  const redacted = redactText(output.subarray(0, command.maximumOutputBytes).toString("utf8"));
  const timedOut = result.error?.message.includes("ETIMEDOUT") ?? false;
  const exitCode = typeof result.status === "number" ? result.status : null;
  const failureClass = timedOut || result.error ? "infrastructure" : exitCode === 0 ? null : "deterministic";

  return {
    id: command.id,
    executable: command.executable,
    args: command.args,
    exitCode,
    durationMs: Date.now() - startedAt,
    timedOut,
    outputTruncated: output.length > command.maximumOutputBytes,
    redacted: redacted.redacted,
    outputSha256: redacted.sha256,
    failureClass
  };
}

/**
 * Gates run with a scrubbed environment, but executable lookup still needs the
 * host PATH. Keep only platform runtime variables from the host and overlay
 * the explicitly allowed gate variables; never inherit the full environment.
 */
function runtimeEnvironment(explicit: Readonly<Record<string, string>> | undefined): Record<string, string> {
  const runtime: Record<string, string> = {};
  const host = process.env;

  // Toolchains such as dotnet/NuGet need the user's cache/profile locations
  // during restore. These are runtime paths, not credentials; keep the
  // allowlist explicit and continue to drop arbitrary variables (API keys,
  // tokens and provider configuration never cross the gate boundary).
  for (const name of [
    "PATH", "Path", "PATHEXT", "SystemRoot", "ComSpec",
    "HOME", "USERPROFILE", "HOMEDRIVE", "HOMEPATH", "LOCALAPPDATA", "APPDATA",
    "TEMP", "TMP", "DOTNET_ROOT", "NUGET_PACKAGES"
  ]) {
    const value = host[name];
    if (value !== undefined) {
      runtime[name] = value;
    }
  }

  Object.assign(runtime, explicit ?? {});
  return runtime;
}

export function toEvidenceCommand(result: QualityGateResult): {
  readonly id: string;
  readonly executable: string;
  readonly args: readonly string[];
  readonly exitCode: number | null;
  readonly durationMs: number | null;
} {
  return {
    id: result.id,
    executable: result.executable,
    args: result.args,
    exitCode: result.exitCode,
    durationMs: result.durationMs
  };
}
