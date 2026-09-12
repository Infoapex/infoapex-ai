import { runBoundedProcess, type BoundedProcessOptions, type BoundedProcessResult } from "./process-control.js";
export interface ClaudeRunOptions extends BoundedProcessOptions { readonly provider: "claude"; }
/** Claude is explicit; callers must pass it again on resume rather than falling back. */
export function runClaude(options: ClaudeRunOptions): Promise<BoundedProcessResult> { return runBoundedProcess(options); }
