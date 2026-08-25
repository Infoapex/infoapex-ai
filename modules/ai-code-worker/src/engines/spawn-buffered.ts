import { spawn } from "node:child_process";

export interface BufferedProcessResult {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly error: Error | null;
  readonly timedOut: boolean;
  readonly outputTruncated: boolean;
}

export interface BufferedProcessOptions {
  readonly cwd: string;
  readonly input?: string;
  readonly timeoutMs: number;
  readonly maximumOutputBytes: number;
  readonly env?: NodeJS.ProcessEnv | Readonly<Record<string, string>>;
  readonly shell?: boolean;
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

    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => {
        if (!settled) {
          child.kill("SIGKILL");
        }
      }, 250).unref();
    }, options.timeoutMs);

    child.stdout.on("data", collect(stdoutChunks));
    child.stderr.on("data", collect(stderrChunks));
    child.on("error", (error) => {
      childError = error;
    });
    child.on("close", (status) => {
      clearTimeout(timeout);
      settled = true;
      resolve({
        status,
        stdout: Buffer.concat(stdoutChunks).toString("utf8"),
        stderr: Buffer.concat(stderrChunks).toString("utf8"),
        error: childError,
        timedOut,
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
