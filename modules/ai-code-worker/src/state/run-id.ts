const SAFE_RUN_ID = /^(?!\.{1,2}$)(?!.*\.$)[A-Za-z0-9._-]{1,128}$/;
const WINDOWS_DEVICE_NAME = /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\..*)?$/i;

/** Run identifiers become directory names in the external state root and in
 * worktree paths. Validate the portable single-segment contract before any
 * path is derived from caller input. */
export function assertSafeWorkerRunId(value: string): void {
  if (!SAFE_RUN_ID.test(value) || WINDOWS_DEVICE_NAME.test(value)) {
    throw new Error(
      "Invalid runId: expected one portable path segment (1-128 ASCII letters, digits, '.', '_' or '-'; '.', '..', trailing dots and Windows device names are forbidden)."
    );
  }
}
