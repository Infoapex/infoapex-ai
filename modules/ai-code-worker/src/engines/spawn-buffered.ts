import { execFileSync, spawn } from "node:child_process";
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";

export type BufferedProcessStopReason = "hard-timeout" | "idle-timeout" | "loop-detected" | null;

export interface BufferedProcessResult {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly error: Error | null;
  readonly timedOut: boolean;
  /** Public, non-sensitive classification of a watchdog stop. */
  readonly stopReason: BufferedProcessStopReason;
  readonly outputTruncated: boolean;
}

/**
 * A provider process must not be allowed to run forever, but a fixed wall clock is
 * the wrong control for real projects: restore/build work can legitimately take
 * several minutes in a fresh task worktree.  The watchdog therefore distinguishes
 * observable progress from silence and has a separate, deliberately high circuit
 * breaker as a final safety net.
 */
export interface BufferedProcessWatchdog {
  /** Stop after this much time with no semantic output or worktree mutation. */
  readonly idleTimeoutMs: number;
  /** Final circuit breaker. This is not a per-task performance target. */
  readonly maximumRuntimeMs: number;
  /** Stop a provider which repeats the same semantic action this many times. */
  readonly maximumRepeatedProgressEvents: number;
  /** Optional worktree to observe. Paths/content are never retained or reported. */
  readonly progressDirectory?: string;
  /** Returns a non-sensitive action identity for a semantic output line, or null. */
  readonly classifyProgressLine?: (stream: "stdout" | "stderr", line: string) => string | null;
}

export interface BufferedProcessOptions {
  readonly cwd: string;
  readonly input?: string;
  readonly timeoutMs: number;
  readonly maximumOutputBytes: number;
  readonly env?: NodeJS.ProcessEnv | Readonly<Record<string, string>>;
  readonly shell?: boolean;
  readonly watchdog?: BufferedProcessWatchdog;
}

export function spawnBuffered(
  executable: string,
  args: readonly string[],
  options: BufferedProcessOptions
): Promise<BufferedProcessResult> {
  return new Promise((resolve) => {
    const child = spawn(executable, args, {
      cwd: options.cwd,
      env: options.env,
      shell: options.shell ?? false,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"]
    });
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let acceptedBytes = 0;
    let timedOut = false;
    let outputTruncated = false;
    let settled = false;
    let childError: Error | null = null;
    let stopReason: BufferedProcessStopReason = null;
    let lastProgressAt = Date.now();
    let lastSignature: string | null = null;
    let repeatedSignatureCount = 0;
    let stdoutRemainder = "";
    let stderrRemainder = "";
    let lastDirectoryFingerprint = options.watchdog?.progressDirectory
      ? directoryFingerprint(options.watchdog.progressDirectory)
      : null;

    const stop = (reason: Exclude<BufferedProcessStopReason, null>) => {
      if (settled || stopReason !== null) return;
      stopReason = reason;
      // On Windows `ChildProcess.kill()` only stops the direct wrapper.  Codex
      // and Claude can have restore/build descendants, so use the OS tree
      // primitive to ensure an idle/loop circuit break cannot leave work behind.
      if (process.platform === "win32" && child.pid !== undefined) {
        try {
          execFileSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
            windowsHide: true,
            stdio: "ignore",
            timeout: 5_000
          });
          return;
        } catch {
          // Fall through to Node's best-effort direct-child kill.
        }
      }
      child.kill("SIGTERM");
      setTimeout(() => {
        if (!settled) child.kill("SIGKILL");
      }, 250).unref();
    };

    const recordProgress = (signature: string | null) => {
      lastProgressAt = Date.now();
      if (!signature || !options.watchdog) return;
      repeatedSignatureCount = signature === lastSignature ? repeatedSignatureCount + 1 : 1;
      lastSignature = signature;
      if (repeatedSignatureCount >= options.watchdog.maximumRepeatedProgressEvents) {
        stop("loop-detected");
      }
    };

    const inspectLines = (stream: "stdout" | "stderr", chunk: Buffer) => {
      if (!options.watchdog?.classifyProgressLine) return;
      const combined = (stream === "stdout" ? stdoutRemainder : stderrRemainder) + chunk.toString("utf8");
      const lines = combined.split(/\r?\n/);
      const remainder = lines.pop() ?? "";
      if (stream === "stdout") stdoutRemainder = remainder;
      else stderrRemainder = remainder;
      for (const line of lines) {
        const signature = options.watchdog.classifyProgressLine(stream, line);
        if (signature) recordProgress(signature);
      }
    };

    const collect = (chunks: Buffer[]) => (chunk: Buffer) => {
      if (acceptedBytes >= options.maximumOutputBytes) {
        outputTruncated = true;
        return;
      }

      const remaining = options.maximumOutputBytes - acceptedBytes;
      const accepted = chunk.length > remaining ? chunk.subarray(0, remaining) : chunk;
      chunks.push(accepted);
      acceptedBytes += accepted.length;
      outputTruncated ||= accepted.length < chunk.length;
    };

    // timeoutMs is retained for non-provider callers. Provider adapters pass the
    // watchdog and get idle/progress control plus a high circuit breaker instead.
    const maximumRuntimeMs = options.watchdog?.maximumRuntimeMs ?? options.timeoutMs;
    const timeout = setTimeout(() => {
      timedOut = true;
      stop(options.watchdog ? "hard-timeout" : "hard-timeout");
    }, maximumRuntimeMs);
    const watchdogInterval = options.watchdog
      ? setInterval(() => {
          const now = Date.now();
          if (options.watchdog?.progressDirectory) {
            const next = directoryFingerprint(options.watchdog.progressDirectory);
            if (next !== lastDirectoryFingerprint) {
              lastDirectoryFingerprint = next;
              // Workspace mutations are progress but intentionally have no action
              // signature: writing different files must never look like a loop.
              recordProgress(null);
            }
          }
          if (options.watchdog && now - lastProgressAt >= options.watchdog.idleTimeoutMs) {
            timedOut = true;
            stop("idle-timeout");
          }
        }, Math.max(1_000, Math.min(5_000, Math.floor(options.watchdog.idleTimeoutMs / 10))))
      : null;

    child.stdout.on("data", (chunk: Buffer) => {
      collect(stdoutChunks)(chunk);
      inspectLines("stdout", chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      collect(stderrChunks)(chunk);
      inspectLines("stderr", chunk);
    });
    child.stdin.on("error", (error) => {
      // Killing a provider tree while its request is still being written is
      // expected to close stdin with EPIPE. It is already represented by the
      // bounded stopReason and must not escape as an uncaught exception.
      if ((error as NodeJS.ErrnoException).code !== "EPIPE") {
        childError = error;
      }
    });
    child.on("error", (error) => {
      childError = error;
    });
    child.on("close", (status) => {
      clearTimeout(timeout);
      if (watchdogInterval) clearInterval(watchdogInterval);
      settled = true;
      resolve({
        status,
        stdout: Buffer.concat(stdoutChunks).toString("utf8"),
        stderr: Buffer.concat(stderrChunks).toString("utf8"),
        error: childError,
        timedOut,
        stopReason,
        outputTruncated
      });
    });

    if (options.input) {
      child.stdin.end(options.input);
    } else {
      child.stdin.end();
    }
  });
}

/** A bounded, metadata-only fingerprint.  It never reads source contents. */
function directoryFingerprint(path: string): string | null {
  try {
    let entries = 0;
    let latestMtime = 0;
    const visit = (current: string, depth: number) => {
      if (depth > 12 || entries >= 4_096) return;
      for (const entry of readdirSync(current, { withFileTypes: true })) {
        if (entry.name === ".git") continue;
        entries += 1;
        if (entries >= 4_096) return;
        const fullPath = join(current, entry.name);
        const stat = statSync(fullPath);
        latestMtime = Math.max(latestMtime, stat.mtimeMs);
        if (entry.isDirectory()) visit(fullPath, depth + 1);
      }
    };
    visit(path, 0);
    return `${entries}:${Math.floor(latestMtime)}`;
  } catch {
    // Worktree observation is a safety enhancement, never a reason to expose a
    // path or make a provider invocation fail before it starts.
    return null;
  }
}
