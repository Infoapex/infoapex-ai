import { readdirSync, statSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

export type DiscoverableEngine = "codex" | "claude";

/**
 * Resolve the current local CLI installation. PATH is authoritative for normal
 * installs; the bounded extension scan covers Codex builds shipped by VS Code,
 * which are often present on disk but not exported into the worker process PATH.
 */
export function discoverEngineExecutable(engine: DiscoverableEngine): string {
  const pathExecutable = findOnPath(engine);
  if (pathExecutable) {
    return pathExecutable;
  }

  for (const root of knownInstallRoots()) {
    const found = findInTree(root, executableNames(engine), 5);
    if (found) {
      return found;
    }
  }

  return engine;
}

function findOnPath(engine: DiscoverableEngine): string | null {
  const command = platform() === "win32" ? "where.exe" : "which";
  const result = spawnSync(command, [engine], {
    encoding: "utf8",
    timeout: 5_000,
    windowsHide: true
  });

  if (result.status !== 0 || typeof result.stdout !== "string") {
    return null;
  }

  return result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.length > 0) ?? null;
}

function knownInstallRoots(): readonly string[] {
  const roots = new Set<string>();
  const home = homedir();
  roots.add(join(home, ".vscode", "extensions"));
  roots.add(join(home, ".vscode-insiders", "extensions"));

  if (platform() === "win32") {
    const localAppData = process.env.LOCALAPPDATA;
    const appData = process.env.APPDATA;
    if (localAppData) {
      roots.add(join(localAppData, "Programs", "Microsoft VS Code", "resources", "app", "extensions"));
      roots.add(join(localAppData, "Programs", "Microsoft VS Code Insiders", "resources", "app", "extensions"));
    }
    if (appData) {
      roots.add(join(appData, "Code", "User", "globalStorage"));
      roots.add(join(appData, "Code - Insiders", "User", "globalStorage"));
    }
  }

  return [...roots];
}

function executableNames(engine: DiscoverableEngine): readonly string[] {
  return platform() === "win32"
    ? [`${engine}.exe`, `${engine}.cmd`, engine]
    : [engine];
}

function findInTree(root: string, names: readonly string[], remainingDepth: number): string | null {
  if (remainingDepth < 0) {
    return null;
  }

  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return null;
  }

  for (const name of names) {
    const candidate = join(root, name);
    try {
      if (statSync(candidate).isFile()) {
        return candidate;
      }
    } catch {
      // A stale extension directory is normal during an editor update.
    }
  }

  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name === "node_modules") {
      continue;
    }
    const found = findInTree(join(root, entry.name), names, remainingDepth - 1);
    if (found) {
      return found;
    }
  }

  return null;
}
