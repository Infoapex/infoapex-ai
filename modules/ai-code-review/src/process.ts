import { spawnSync } from "node:child_process";
import type { CommandResult } from "./types.js";

export function runCommand(command: readonly string[], args: readonly string[], cwd: string, timeoutMs = 120_000, input?: string): CommandResult {
  const child = spawnSync(command[0]!, [...command.slice(1), ...args], {
    cwd,
    input,
    encoding: "utf8",
    timeout: timeoutMs,
    windowsHide: true,
    maxBuffer: 4 * 1024 * 1024
  });

  return {
    status: child.status,
    stdout: typeof child.stdout === "string" ? child.stdout : "",
    stderr: typeof child.stderr === "string" ? child.stderr : "",
    ...(child.error ? { error: child.error.message } : {})
  };
}

export function parseJsonOutput<T>(result: CommandResult): T | null {
  const text = result.stdout.trim();
  if (!text) return null;

  try {
    return JSON.parse(text) as T;
  } catch {
    const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      try {
        return JSON.parse(lines[index]!) as T;
      } catch {
        continue;
      }
    }
    return null;
  }
}

export function commandFailure(result: CommandResult): string {
  return [result.error, result.stderr, result.stdout].filter(Boolean).join("\n").trim().slice(0, 4000) || "Command failed without diagnostic output.";
}
