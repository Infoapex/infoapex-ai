import type {
  ContextProvider,
  ContextProviderBrief,
  ContextProviderCallResult,
  ContextProviderHealth,
  ContextProviderImpact,
  ContextProviderRefreshResult,
  ContextProviderSymbolMatch
} from "./types.js";

const UNAVAILABLE: ContextProviderCallResult<never> = {
  status: "UNAVAILABLE",
  reason: 'contextProvider is "none"'
};

/**
 * Default provider. Every call resolves UNAVAILABLE instead of throwing, so callers
 * that don't special-case the provider kind still get a well-formed result.
 */
export class NoneContextProvider implements ContextProvider {
  readonly kind = "none" as const;

  health(): Promise<ContextProviderCallResult<ContextProviderHealth>> {
    return Promise.resolve(UNAVAILABLE);
  }

  brief(_taskDescription: string): Promise<ContextProviderCallResult<ContextProviderBrief>> {
    return Promise.resolve(UNAVAILABLE);
  }

  findSymbol(_symbol: string): Promise<ContextProviderCallResult<readonly ContextProviderSymbolMatch[]>> {
    return Promise.resolve(UNAVAILABLE);
  }

  impact(_symbol: string): Promise<ContextProviderCallResult<ContextProviderImpact>> {
    return Promise.resolve(UNAVAILABLE);
  }

  refresh(): Promise<ContextProviderCallResult<ContextProviderRefreshResult>> {
    return Promise.resolve(UNAVAILABLE);
  }
}
