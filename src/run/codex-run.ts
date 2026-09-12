import { runBoundedProcess, type BoundedProcessOptions, type BoundedProcessResult } from "./process-control.js";
export interface CodexRunOptions extends BoundedProcessOptions { readonly provider: "codex"; }
/** Codex is explicit; callers must pass it again on resume rather than falling back. */
export function runCodex(options: CodexRunOptions): Promise<BoundedProcessResult> { return runBoundedProcess(options); }
