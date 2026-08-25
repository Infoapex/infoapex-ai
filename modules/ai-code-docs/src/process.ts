import { spawnSync } from "node:child_process";
import type { CommandResult } from "./types.js";

export function runCommand(command: readonly string[], args: readonly string[], cwd: string): CommandResult {
  const [executable, ...baseArgs] = command;
  if (!executable) return { status: 127, stdout: "", stderr: "Empty command." };
  const result = spawnSync(executable, [...baseArgs, ...args], {
    cwd,
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: 8 * 1024 * 1024
  });
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    ...(result.error ? { error: result.error.message } : {})
  };
}

export function parseJsonOutput<T>(result: CommandResult): T | null {
  const text = result.stdout.trim();
  if (!text) return null;
  try {
    return JSON.parse(text) as T;
  } catch {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start < 0 || end <= start) return null;
    try { return JSON.parse(text.slice(start, end + 1)) as T; } catch { return null; }
  }
}

export function commandFailure(result: CommandResult): string {
  return result.error ?? (result.stderr.trim() || result.stdout.trim() || `Command exited with status ${result.status}.`);
}
