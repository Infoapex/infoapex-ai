import { SchemaRegistry } from "../schema/json-schema.js";
import { spawnBuffered } from "../engines/spawn-buffered.js";
import type {
  ContextProvider,
  ContextProviderBrief,
  ContextProviderCallResult,
  ContextProviderHealth,
  ContextProviderImpact,
  ContextPackage,
  ContextPackageCompileRequest,
  ContextProviderRefreshResult,
  ContextProviderSymbolMatch
} from "./types.js";

const DEFAULT_EXECUTABLE = "ai-code-control";
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAXIMUM_OUTPUT_BYTES = 1_000_000;

export interface AiCodeControlCliProviderConfig {
  readonly executable?: string;
  readonly baseArgs?: readonly string[];
  readonly cwd: string;
  readonly timeoutMs?: number;
  readonly maximumOutputBytes?: number;
  readonly schemaRegistry?: SchemaRegistry;
}

interface RawEnvelope {
  readonly status?: unknown;
  readonly error?: unknown;
  readonly message?: unknown;
}

/**
 * CLI-JSON-only adapter per AICW-ADR-001 §5: talks to `ai-code-control` exclusively
 * through subprocess stdout/exit codes, never SQLite or in-process references.
 *
 * The CLI run path invokes health/brief/impact/refresh through this adapter. Per-task
 * briefs and declared symbol lookups are converted into bounded advisory prompt data;
 * failures remain non-blocking because the provider is optional.
 */
export class AiCodeControlCliProvider implements ContextProvider {
  readonly kind = "ai-code-control" as const;

  private readonly executable: string;
  private readonly baseArgs: readonly string[];
  private readonly cwd: string;
  private readonly timeoutMs: number;
  private readonly maximumOutputBytes: number;
  private readonly schemaRegistry: SchemaRegistry;

  constructor(config: AiCodeControlCliProviderConfig) {
    this.executable = config.executable ?? DEFAULT_EXECUTABLE;
    this.baseArgs = config.baseArgs ?? [];
    this.cwd = config.cwd;
    this.timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maximumOutputBytes = config.maximumOutputBytes ?? DEFAULT_MAXIMUM_OUTPUT_BYTES;
    this.schemaRegistry = config.schemaRegistry ?? SchemaRegistry.load();
  }

  async health(): Promise<ContextProviderCallResult<ContextProviderHealth>> {
    return this.run<ContextProviderHealth>(["health", "--json"], "context-provider-health.schema.json", (body) => ({
      available: (body as { available: boolean | null }).available ?? false,
      version: (body as { version: string | null }).version,
      detail: (body as { detail: string | null }).detail
    }));
  }

  async brief(taskDescription: string): Promise<ContextProviderCallResult<ContextProviderBrief>> {
    return this.run<ContextProviderBrief>(
      ["brief", "--json", "--task", taskDescription],
      "context-provider-brief.schema.json",
      (body) => ({
        summary: (body as { summary: string | null }).summary ?? "",
        relevantFiles: (body as { relevantFiles: readonly string[] | null }).relevantFiles ?? []
      })
    );
  }

  async findSymbol(symbol: string): Promise<ContextProviderCallResult<readonly ContextProviderSymbolMatch[]>> {
    return this.run<readonly ContextProviderSymbolMatch[]>(
      ["find-symbol", "--json", "--symbol", symbol],
      "context-provider-find-symbol.schema.json",
      (body) => (body as { matches: readonly ContextProviderSymbolMatch[] | null }).matches ?? []
    );
  }

  async impact(symbol: string): Promise<ContextProviderCallResult<ContextProviderImpact>> {
    return this.run<ContextProviderImpact>(
      ["impact", "--json", "--symbol", symbol],
      "context-provider-impact.schema.json",
      (body) => ({
        symbol: (body as { symbol: string | null }).symbol ?? symbol,
        affectedFiles: (body as { affectedFiles: readonly string[] | null }).affectedFiles ?? [],
        riskNotes: (body as { riskNotes: readonly string[] | null }).riskNotes ?? []
      })
    );
  }

  async compileContext(request: ContextPackageCompileRequest): Promise<ContextProviderCallResult<ContextPackage>> {
    return this.run<ContextPackage>(
      [
        "context-compile",
        "--json",
        "--manifest",
        request.manifestPath,
        "--manifest-sha256",
        request.manifestSha256,
        "--task",
        request.taskId,
        "--maximum-tokens",
        String(request.maximumTokens),
        "--repo",
        this.cwd
      ],
      "context-package.schema.json",
      (body) => body as unknown as ContextPackage
    );
  }

  async refresh(): Promise<ContextProviderCallResult<ContextProviderRefreshResult>> {
    return this.run<ContextProviderRefreshResult>(["refresh", "--json"], "context-provider-refresh.schema.json", (body) => ({
      refreshed: (body as { refreshed: boolean | null }).refreshed ?? false,
      detail: (body as { detail: string | null }).detail
    }));
  }

  private async run<T>(
    args: readonly string[],
    schemaName: string,
    mapBody: (body: Record<string, unknown>) => T
  ): Promise<ContextProviderCallResult<T>> {
    const result = await spawnBuffered(this.executable, [...this.baseArgs, ...args], {
      cwd: this.cwd,
      timeoutMs: this.timeoutMs,
      maximumOutputBytes: this.maximumOutputBytes
    });

    if (result.error && isMissingExecutableError(result.error)) {
      return { status: "UNAVAILABLE", reason: `${this.executable} executable not found` };
    }

    if (result.timedOut) {
      return { status: "ERROR", reason: `${this.executable} ${args[0]} timed out after ${this.timeoutMs}ms` };
    }

    if (result.error) {
      return { status: "ERROR", reason: result.error.message };
    }

    let parsed: unknown;

    try {
      parsed = JSON.parse(result.stdout);
    } catch {
      return { status: "ERROR", reason: `${this.executable} ${args[0]} did not return valid JSON on stdout` };
    }

    const envelope = parsed as RawEnvelope;

    if (envelope.status === "error") {
      const reason = typeof envelope.message === "string"
        ? envelope.message
        : typeof envelope.error === "string"
          ? envelope.error
          : "unknown provider error";
      return { status: "ERROR", reason };
    }

    const validation = this.schemaRegistry.validate(schemaName, parsed);

    if (!validation.valid) {
      return {
        status: "ERROR",
        reason: `${this.executable} ${args[0]} response failed schema validation: ${validation.errors
          .map((issue) => `${issue.instancePath} ${issue.message}`)
          .join("; ")}`
      };
    }

    return { status: "OK", value: mapBody(parsed as Record<string, unknown>) };
  }
}

function isMissingExecutableError(error: Error): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}
