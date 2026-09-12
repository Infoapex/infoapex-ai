import { spawn } from "node:child_process";

export interface BoundedProcessOptions { readonly command: string; readonly args: readonly string[]; readonly cwd: string; readonly timeoutMs: number; readonly maximumOutputBytes: number; readonly maximumProcesses?: number; readonly env?: NodeJS.ProcessEnv; }
export interface BoundedProcessResult { readonly status: "DONE" | "BLOCKED"; readonly code?: "PROCESS_TIMEOUT" | "OUTPUT_LIMIT" | "PROCESS_LIMIT" | "PROCESS_FAILED"; readonly exitCode: number | null; readonly output: string; readonly outputBytes: number; }
/** Bounded subprocess wrapper.  It kills the process group where supported, retains only
 * capped output, and always resolves to a machine-readable terminal result. */
export function runBoundedProcess(options: BoundedProcessOptions): Promise<BoundedProcessResult> {
  if (!Number.isInteger(options.maximumProcesses ?? 1) || (options.maximumProcesses ?? 1) !== 1) return Promise.resolve({ status: "BLOCKED", code: "PROCESS_LIMIT", exitCode: null, output: "", outputBytes: 0 });
  return new Promise((resolve) => {
    let output = "", bytes = 0, terminal: BoundedProcessResult["code"] | undefined;
    const child = spawn(options.command, [...options.args], { cwd: options.cwd, env: options.env, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"] });
    const finish = (exitCode: number | null) => resolve({ status: terminal ? "BLOCKED" : exitCode === 0 ? "DONE" : "BLOCKED", ...(terminal ? { code: terminal } : exitCode === 0 ? {} : { code: "PROCESS_FAILED" as const }), exitCode, output, outputBytes: bytes });
    const stop = (code: NonNullable<typeof terminal>) => { if (terminal) return; terminal = code; try { if (process.platform !== "win32" && child.pid) process.kill(-child.pid, "SIGKILL"); else child.kill("SIGKILL"); } catch { child.kill("SIGKILL"); } };
    const receive = (chunk: Buffer) => { bytes += chunk.length; if (bytes <= options.maximumOutputBytes) output += chunk.toString("utf8"); else stop("OUTPUT_LIMIT"); };
    child.stdout.on("data", receive); child.stderr.on("data", receive);
    const timer = setTimeout(() => stop("PROCESS_TIMEOUT"), options.timeoutMs);
    child.once("error", () => { terminal = "PROCESS_FAILED"; }); child.once("close", (code) => { clearTimeout(timer); finish(code); });
  });
}
