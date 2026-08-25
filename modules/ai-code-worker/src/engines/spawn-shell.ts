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
 * A bare command name (e.g. "codex") that resolves via PATH to a .cmd/.bat is not
 * covered here - both real engine installs on this machine resolve to .exe, so this is
 * a known, accepted gap for the PATH-resolved-bare-name-to-.cmd case specifically, not
 * the full-path case this function does cover.
 */
export function needsShellWrapper(executable: string): boolean {
  return process.platform === "win32" && /\.(cmd|bat)$/i.test(executable);
}
