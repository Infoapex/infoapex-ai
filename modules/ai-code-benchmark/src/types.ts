export const CONFIG_VERSION = "1.0" as const;

export type BenchmarkArm = "direct" | "orchestrated-no-icm" | "full-icm" | "candidate";
export type AdapterCommand = readonly [string, ...string[]];
export type AdapterProvider = "codex" | "claude" | "fake";

export interface BenchmarkConfig {
  readonly schemaVersion: typeof CONFIG_VERSION;
  readonly stateRoot: string | null;
  readonly commands: {
    readonly codex: readonly string[];
    readonly claude: readonly string[];
    readonly infoapex: readonly string[];
    readonly aiCodeControl: readonly string[];
  };
  readonly capabilities: {
    /** Defaults false. True is accepted only with the complete BENCH-09 pilot contract. */
    readonly liveExecution: boolean;
    readonly networkExpansion: false;
    readonly publish: false;
    readonly secretForwarding: false;
  };
  readonly pilot?: {
    readonly schemaVersion: "bench-09-live.v1";
    readonly trustedFixtureOnly: true;
    readonly maximumInvocations: 30;
    readonly equalBudgets: true;
    readonly sharedConfigHash: string;
    readonly arms: {
      readonly "orchestrated-no-icm": { readonly contextProvider: "none"; readonly contextPackageMode: "off" };
      readonly "full-icm": { readonly contextProvider: "ai-code-control"; readonly contextPackageMode: "enforce" };
    };
  };
}

export interface AdapterRequest {
  readonly arm: BenchmarkArm;
  readonly repositoryPath: string;
  readonly taskId: string;
  readonly seed: number;
  /** Direct provider prompt. It is sent as stdin or a single argv token with shell disabled. */
  readonly prompt: string;
  readonly provider: AdapterProvider;
  readonly model: string | null;
  readonly effort: string | null;
  readonly permissions: {
    readonly sandbox: string | null;
    readonly mode: string | null;
    readonly allowedTools: readonly string[];
  };
  readonly limits: {
    readonly timeoutMs: number;
    readonly maximumOutputBytes: number;
  };
  /** Explicit, non-sensitive parent environment names. Secret-looking names are always rejected. */
  readonly environmentAllowlist?: readonly string[];
  /** Required only by the Infoapex public root adapter. This is evaluator-produced public plan input. */
  readonly orchestrationPlanPath?: string;
  /** Declares the public worker configuration already present in this isolated repository. */
  readonly armConfiguration?: {
    readonly contextProvider: "none" | "ai-code-control";
    readonly contextPackageMode: "off" | "observe" | "enforce";
    readonly candidateCapability?: string;
  };
}

export interface AdapterUsage {
  readonly inputUncachedTokens: number | null;
  readonly cacheReadTokens: number | null;
  readonly cacheWriteTokens: number | null;
  readonly outputTokens: number | null;
  readonly totalTokens: number | null;
  readonly costUsd: number | null;
}

export interface BoundedProcessResult {
  readonly startedAt: string;
  readonly completedAt: string;
  readonly elapsedMs: number;
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly timedOut: boolean;
  readonly outputTruncated: boolean;
  readonly stdout: string;
  readonly stderr: string;
  readonly processError: string | null;
  readonly rawOutputSha256: string;
  readonly capturedBytes: number;
  readonly forwardedEnvironment: readonly string[];
}

export interface AdapterResult {
  readonly status: "DONE" | "BLOCKED" | "UNSUPPORTED";
  readonly message: string;
  readonly adapter: {
    readonly id: string;
    readonly adapterVersion: string;
    readonly parserVersion: string;
    readonly executable: string | null;
    readonly executableVersion: string | null;
  };
  readonly execution: {
    readonly arm: BenchmarkArm;
    readonly provider: AdapterProvider;
    readonly model: string | null;
    readonly effort: string | null;
    readonly permissions: AdapterRequest["permissions"];
    readonly configuration: AdapterRequest["armConfiguration"] | null;
    readonly forwardedEnvironment: readonly string[];
  };
  readonly timing: {
    readonly startedAt: string;
    readonly completedAt: string;
    readonly elapsedMs: number;
  };
  readonly termination: {
    readonly exitCode: number | null;
    readonly signal: NodeJS.Signals | null;
    readonly timedOut: boolean;
    readonly outputTruncated: boolean;
  };
  readonly output: {
    readonly rawOutputSha256: string;
    readonly capturedBytes: number;
    readonly redacted: true;
  };
  readonly usage: AdapterUsage;
}

export interface BenchmarkAdapter {
  readonly id: string;
  execute(request: AdapterRequest): Promise<AdapterResult>;
  doctor(): Promise<AdapterDoctorReport>;
}

export interface AdapterDoctorReport {
  readonly id: string;
  readonly status: "PASS" | "UNSUPPORTED";
  readonly executable: string;
  readonly executableVersion: string | null;
  readonly requiredCapabilities: readonly string[];
  readonly missingCapabilities: readonly string[];
  readonly message: string;
}

export interface CommandResult {
  readonly status: "DONE" | "UNSUPPORTED" | "BLOCKED";
  readonly command: string;
  readonly message?: string;
  readonly details?: Record<string, unknown>;
}
