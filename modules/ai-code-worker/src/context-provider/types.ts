export type ContextProviderKind = "none" | "ai-code-control";

export interface ContextProviderHealth {
  readonly available: boolean;
  readonly version: string | null;
  readonly detail: string | null;
}

export interface ContextProviderBrief {
  readonly summary: string;
  readonly relevantFiles: readonly string[];
}

export interface ContextProviderSymbolMatch {
  readonly symbol: string;
  readonly file: string;
  readonly line: number | null;
}

export interface ContextProviderImpact {
  readonly symbol: string;
  readonly affectedFiles: readonly string[];
  readonly riskNotes: readonly string[];
}

export interface ContextProviderRefreshResult {
  readonly refreshed: boolean;
  readonly detail: string | null;
}

export type ContextProviderCallResult<T> =
  | { readonly status: "OK"; readonly value: T }
  | { readonly status: "UNAVAILABLE"; readonly reason: string }
  | { readonly status: "ERROR"; readonly reason: string };

/**
 * CLI-JSON-only contract per AICW-ADR-001 §5: no SQLite access, no internal type
 * references. `ai-code-worker` must behave identically whether this is the
 * `NoneContextProvider` (default, `contextProvider: "none"`) or a real
 * `AiCodeControlCliProvider` - callers treat every outcome as one of the three
 * `ContextProviderCallResult` variants, never as a thrown exception.
 */
export interface ContextProvider {
  readonly kind: ContextProviderKind;
  health(): Promise<ContextProviderCallResult<ContextProviderHealth>>;
  brief(taskDescription: string): Promise<ContextProviderCallResult<ContextProviderBrief>>;
  findSymbol(symbol: string): Promise<ContextProviderCallResult<readonly ContextProviderSymbolMatch[]>>;
  impact(symbol: string): Promise<ContextProviderCallResult<ContextProviderImpact>>;
  refresh(): Promise<ContextProviderCallResult<ContextProviderRefreshResult>>;
}
