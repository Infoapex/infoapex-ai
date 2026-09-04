import { createHash } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import type { AdapterCommand, BoundedProcessResult } from "../types.js";

const DEFAULT_ENVIRONMENT = ["PATH", "PATHEXT", "SystemRoot", "SystemDrive", "WINDIR", "ComSpec", "TEMP", "TMP", "HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA"] as const;
const SENSITIVE_ENVIRONMENT = /(?:token|secret|password|passwd|api[_-]?key|authorization|cookie|credential)/i;

/** Commands are always passed to spawn with shell:false. A command is an executable plus fixed argument tokens. */
export function assertCommand(command: readonly string[]): asserts command is AdapterCommand {
  if (command.length === 0 || command.some((part) => typeof part !== "string" || part.length === 0 || /[\u0000\r\n]/.test(part))) {
    throw new Error("Adapter command must be a non-empty executable and argument array without control characters.");
  }
}

export function safeEnvironment(names: readonly string[] = []): { readonly environment: NodeJS.ProcessEnv; readonly forwarded: readonly string[] } {
  const requested = [...new Set([...DEFAULT_ENVIRONMENT, ...names])];
  const environment: NodeJS.ProcessEnv = {};
  const forwarded: string[] = [];
  for (const name of requested) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) || SENSITIVE_ENVIRONMENT.test(name)) continue;
    const value = process.env[name];
    if (value !== undefined) {
      environment[name] = value;
      forwarded.push(name);
    }
  }
  return { environment, forwarded };
}

export async function runBoundedProcess(input: {
  readonly command: readonly string[];
  readonly cwd: string;
  readonly stdin?: string;
  readonly timeoutMs: number;
  readonly maximumOutputBytes: number;
  readonly environmentNames?: readonly string[];
}): Promise<BoundedProcessResult> {
  assertCommand(input.command);
  if (!Number.isInteger(input.timeoutMs) || input.timeoutMs < 1) throw new Error("Adapter timeoutMs must be a positive integer.");
  if (!Number.isInteger(input.maximumOutputBytes) || input.maximumOutputBytes < 1) throw new Error("Adapter maximumOutputBytes must be a positive integer.");

  const startedAt = new Date().toISOString();
  const started = Date.now();
  const { environment, forwarded } = safeEnvironment(input.environmentNames);
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  let capturedBytes = 0;
  let outputTruncated = false;
  let timedOut = false;
  let processError: string | null = null;

  return await new Promise<BoundedProcessResult>((resolveResult) => {
    let settled = false;
    const child = spawn(input.command[0]!, input.command.slice(1), { cwd: input.cwd, env: environment, shell: false, windowsHide: true, detached: process.platform !== "win32", stdio: ["pipe", "pipe", "pipe"] });
    let terminationStarted = false;
    const terminate = (): void => {
      if (terminationStarted || child.exitCode !== null || child.pid === undefined) return;
      terminationStarted = true;
      if (process.platform === "win32") {
        // Node's child.kill() only targets the direct process on Windows. taskkill /T
        // is an OS process-tree primitive and is invoked with fixed argv/shell:false.
        try { execFileSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore", timeout: 5_000 }); }
        catch { if (!child.killed) child.kill(); }
      } else {
        // detached:true makes the child a process-group leader, so a negative PID
        // terminates descendants as well as the direct CLI process.
        try { process.kill(-child.pid, "SIGTERM"); } catch { if (!child.killed) child.kill("SIGTERM"); }
        const escalation = setTimeout(() => { try { process.kill(-child.pid!, "SIGKILL"); } catch { /* already exited */ } }, 250);
        escalation.unref();
      }
    };
    const timer = setTimeout(() => { timedOut = true; terminate(); }, input.timeoutMs);
    const collect = (target: Buffer[], chunk: Buffer): void => {
      const available = input.maximumOutputBytes - capturedBytes;
      if (available <= 0) { outputTruncated = true; terminate(); return; }
      const accepted = chunk.subarray(0, available);
      target.push(accepted);
      capturedBytes += accepted.length;
      if (accepted.length !== chunk.length) { outputTruncated = true; terminate(); }
    };
    child.stdout.on("data", (chunk: Buffer) => collect(stdout, chunk));
    child.stderr.on("data", (chunk: Buffer) => collect(stderr, chunk));
    child.on("error", (error) => { processError = error.message; });
    child.on("close", (exitCode, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const stdoutText = Buffer.concat(stdout).toString("utf8");
      const stderrText = Buffer.concat(stderr).toString("utf8");
      resolveResult({ startedAt, completedAt: new Date().toISOString(), elapsedMs: Date.now() - started, exitCode, signal, timedOut, outputTruncated, stdout: stdoutText, stderr: stderrText, processError, rawOutputSha256: createHash("sha256").update(stdoutText).update("\n").update(stderrText).digest("hex"), capturedBytes, forwardedEnvironment: forwarded });
    });
    if (input.stdin !== undefined) child.stdin.end(input.stdin); else child.stdin.end();
  });
}
