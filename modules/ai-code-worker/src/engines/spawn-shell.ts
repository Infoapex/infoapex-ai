import { existsSync } from "node:fs";
import { delimiter, join } from "node:path";

/**
 * Windows cannot execute .cmd/.bat files directly via CreateProcess - spawnSync given a
 * full path to one, without shell:true, fails with EINVAL (confirmed live). This is
 * relevant beyond test fixtures: a real --claude-executable/--codex-executable override
 * pointed at an npm-global .cmd shim (common on Windows) would hit the same failure.
 *
 * shell:true is not used unconditionally: when enabled, Node joins [executable, ...args]
 * into a single string for cmd.exe without quoting the executable portion, so an
 * executable path containing spaces breaks (confirmed live - process.execPath is
 * commonly "C:\Program Files\nodejs\node.exe" on Windows, and shell:true alone turned a
 * working invocation into "'C:\Program' is not recognized..."). Scoping the wrapper to
 * only .cmd/.bat executables avoids that regression while still fixing the real case.
 *
 * Bare command names that resolve via PATH to a .cmd/.bat are normalized by the
 * quality-gate runner before this predicate is called; this predicate remains
 * deliberately concerned only with the final executable form.
 */
export function needsShellWrapper(executable: string): boolean {
  return process.platform === "win32" && /\.(cmd|bat)$/i.test(executable);
}

/** Resolve bare Windows command shims before choosing the spawn strategy. */
export function resolveCommandShim(executable: string, env: NodeJS.ProcessEnv): string {
  if (process.platform !== "win32" || executable.includes("\\") || executable.includes("/") || /\.[^./\\]+$/i.test(executable)) return executable;
  const pathValue = env.Path ?? env.PATH;
  if (!pathValue) return executable;
  for (const directory of pathValue.split(delimiter)) {
    if (!directory) continue;
    for (const extension of [".exe", ".com", ".cmd", ".bat"]) {
      // Keep a PATH-relative name: shell:true does not quote absolute paths
      // containing spaces. Respect native executables before command shims.
      if (existsSync(join(directory, `${executable}${extension}`))) return `${executable}${extension}`;
    }
  }
  return executable;
}
