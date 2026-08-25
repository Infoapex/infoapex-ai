import type { ProjectConfig } from "../config/project-config.js";
import { AiCodeControlCliProvider } from "./ai-code-control-cli.js";
import { NoneContextProvider } from "./none-provider.js";
import type { ContextProvider } from "./types.js";

export interface ResolveContextProviderOptions {
  readonly repositoryRoot: string;
}

/**
 * Feature flag entry point (AICW-ADR-001 §5, Part B / Phase 4 stage 1). Absent config
 * or an explicit "none" both resolve to `NoneContextProvider`, so a repository that has
 * never heard of `ai-code-control` behaves exactly as it did before this module existed.
 */
export function resolveContextProvider(
  config: ProjectConfig | null,
  options: ResolveContextProviderOptions
): ContextProvider {
  const kind = config?.contextProvider ?? "none";

  if (kind === "none") {
    return new NoneContextProvider();
  }

  const adapterConfig = config?.adapters?.aiCodeControl;

  return new AiCodeControlCliProvider({
    cwd: options.repositoryRoot,
    executable: adapterConfig?.executable,
    timeoutMs: adapterConfig?.timeoutSeconds !== undefined ? adapterConfig.timeoutSeconds * 1000 : undefined,
    maximumOutputBytes: adapterConfig?.maximumOutputBytes
  });
}
