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

export interface ContextPackageSource {
  readonly sourceId: string;
  readonly sourceType: "file" | "symbol" | "contract" | "decision" | "memory" | "external" | "generated";
  readonly canonicalRef: string;
  readonly sourceHash: string;
  readonly sourceCommit: string | null;
  readonly authority: "canonical" | "advisory" | "proposed" | "generated";
  readonly selectionReason: string;
  readonly contentRange?: { readonly startLine: number; readonly endLine: number };
  readonly renderedContent?: string;
}

export interface ContextPackage {
  readonly schemaVersion: "1.0";
  readonly packageId: string;
  readonly runId: string;
  readonly taskId: string;
  readonly manifestSha256: string;
  readonly compilerVersion: string;
  readonly sources: readonly ContextPackageSource[];
  readonly budget: {
    readonly measurement: "tokenizer" | "characters-fallback";
    readonly maximumTokens: number;
    readonly estimatedTokens: number;
    readonly maximumCharacters?: number;
    readonly estimatedCharacters?: number;
    readonly omittedSources: readonly {
      readonly sourceId: string;
      readonly reason: "budget" | "policy" | "unavailable" | "invalid";
      readonly estimatedTokens: number;
    }[];
  };
  readonly diagnostics: readonly {
    readonly code: string;
    readonly severity: "info" | "warning" | "error";
    readonly message: string;
    readonly sourceId?: string;
  }[];
  readonly contextDigest: string;
  readonly createdAt: string;
}

export interface ContextPackageCompileRequest {
  readonly manifestPath: string;
  readonly manifestSha256: string;
  readonly taskId: string;
  readonly maximumTokens: number;
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
  compileContext(request: ContextPackageCompileRequest): Promise<ContextProviderCallResult<ContextPackage>>;
  refresh(): Promise<ContextProviderCallResult<ContextProviderRefreshResult>>;
}
