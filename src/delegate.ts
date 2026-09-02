/**
 * Subprocess delegation and envelope normalization (ADR-0003, P4 roadmap steps 3-5).
 * The root CLI's own output is always this one shape, regardless of which module
 * answered or what that module's own raw stdout looked like - see ADR-0003's
 * "JSON envelope and exit codes" section for the reasoning.
 */

import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import type { ModuleDescriptor, RootCommand } from "./registry.js";
import { SCHEMA_VERSION } from "./registry.js";

export type EnvelopeStatus = "PASS" | "WARN" | "BLOCKED";

export interface RootEnvelope {
  readonly schemaVersion: "1.0";
  readonly command: RootCommand;
  readonly module: string | null;
  readonly status: EnvelopeStatus;
  readonly exitCode: number;
  readonly body: unknown;
}

export interface DelegateOptions {
  readonly command: RootCommand;
  readonly module: ModuleDescriptor;
  /** The module's own subcommand to invoke. Callers normally resolve this via
   *  registry.ts's moduleSubcommand(module, command); it is a separate, explicit
   *  parameter (not derived internally) so a command like `resume` can delegate to
   *  more than one of a module's subcommands (its own `status` for an existence
   *  check, then `run`) without the registry needing a many-to-one command mapping. */
  readonly subcommand: string;
  readonly bundleRoot: string;
  /** Args after the root command name, forwarded verbatim to the module's own
   *  subcommand - the root CLI never reinterprets a module's own flags. */
  readonly args: readonly string[];
  readonly execPath?: string;
}

/** Spawns one module's CLI for one root command and normalizes its result. Never
 *  throws: a missing module, a non-zero exit, or non-JSON stdout are all reported as
 *  a BLOCKED envelope, not an unhandled exception - a caller that fans this out
 *  across several modules (doctor) must be able to keep going regardless. */
export function delegate(options: DelegateOptions): RootEnvelope {
  const cliPath = join(options.bundleRoot, options.module.cliRelativePath);

  if (!existsSync(cliPath)) {
    return {
      schemaVersion: SCHEMA_VERSION,
      command: options.command,
      module: options.module.name,
      status: "BLOCKED",
      exitCode: 2,
      body: {
        findings: [
          {
            severity: "blocker",
            code: "MODULE_NOT_AVAILABLE",
            message: `Module '${options.module.name}' CLI not found at ${cliPath}. Run 'npm run setup && npm run build' first.`
          }
        ]
      }
    };
  }

  const forwardedArgs = options.args.includes("--json") ? options.args : [...options.args, "--json"];
  const execPath = options.execPath ?? process.execPath;
  const result = spawnSync(execPath, [cliPath, options.subcommand, ...forwardedArgs], { encoding: "utf8" });

  const stdout = result.stdout ?? "";
  const stderr = result.stderr ?? "";
  const exitCode = result.status ?? (result.error ? 1 : 0);
  // Some modules (ai-code-review's top-level catch) write a thrown error's JSON to
  // stderr while writing every normal completion to stdout - stdout wins when both
  // happen to parse, but a module's structured body must not be discarded just
  // because it landed on the "wrong" stream.
  const parsedStdout = parseJson(stdout);
  const parsed = parsedStdout !== undefined ? parsedStdout : parseJson(stderr);

  if (parsed === undefined) {
    return {
      schemaVersion: SCHEMA_VERSION,
      command: options.command,
      module: options.module.name,
      status: exitCode === 0 ? "PASS" : "BLOCKED",
      exitCode,
      body: {
        findings: [
          {
            severity: exitCode === 0 ? "info" : "blocker",
            code: "NON_JSON_OUTPUT",
            message: (stderr || stdout || "Module produced no output.").slice(-2000)
          }
        ]
      }
    };
  }

  return {
    schemaVersion: SCHEMA_VERSION,
    command: options.command,
    module: options.module.name,
    status: statusFromModuleOutput(parsed, exitCode),
    exitCode,
    body: parsed
  };
}

/** A module's own `status`/`schemaVersion` field, if present, wins outright - the
 *  root CLI never second-guesses a module's verdict, only maps its vocabulary
 *  ("DONE"/"FAILED" from ai-code-worker's own contract, "PASS"/"BLOCKED" from
 *  ai-code-review/ai-code-docs) onto the root's three-value envelope status. */
function statusFromModuleOutput(body: unknown, exitCode: number): EnvelopeStatus {
  const status = readStringField(body, "status");
  if (status === "PASS" || status === "DONE") return "PASS";
  if (status === "WARN") return "WARN";
  if (status === "BLOCKED" || status === "FAILED") return "BLOCKED";
  return exitCode === 0 ? "PASS" : "BLOCKED";
}

function readStringField(value: unknown, field: string): string | null {
  if (value && typeof value === "object" && field in value) {
    const raw = (value as Record<string, unknown>)[field];
    return typeof raw === "string" ? raw : null;
  }
  return null;
}

/** `undefined` (not `null`) specifically means "not parseable" - `null` is itself a
 *  valid parsed JSON value and must not be conflated with parse failure. */
function parseJson(text: string): unknown {
  const trimmed = text.trim();
  if (!trimmed) return undefined;
  try {
    return JSON.parse(trimmed);
  } catch {
    return undefined;
  }
}
