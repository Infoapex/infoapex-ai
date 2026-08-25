import { existsSync, mkdirSync, readFileSync, symlinkSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { isPathInside } from "../state/state-root.js";
import type { CommandSpec } from "./quality-gate.js";

export interface QualityGateConfig {
  readonly schemaVersion: "1.0";
  readonly gates: readonly QualityGateDefinition[];
}

export interface QualityGateDefinition {
  readonly id: string;
  readonly description?: string;
  readonly workingDirectory: string;
  readonly executable: string;
  readonly args: readonly string[];
  readonly timeoutSeconds: number;
  readonly allowedEnvironmentVariables: readonly string[];
  readonly linkedDirectories?: readonly QualityGateLinkedDirectory[];
}

export interface QualityGateLinkedDirectory {
  readonly fromRepository: string;
  readonly toWorktree: string;
}

export interface ResolveQualityGateInput {
  readonly repositoryRoot: string;
  readonly executionRoot: string;
  readonly gate: string;
  readonly defaultTimeoutMs: number;
  readonly maximumOutputBytes?: number;
  readonly env?: NodeJS.ProcessEnv;
}

export interface ResolveQualityGateResult {
  readonly status: "PASS" | "BLOCKED";
  readonly command: CommandSpec | null;
  readonly finding: QualityGateFinding | null;
}

export interface QualityGateFinding {
  readonly code:
    | "QUALITY_GATE_NOT_FOUND"
    | "QUALITY_GATE_INVALID_COMMAND"
    | "QUALITY_GATE_WORKDIR_OUTSIDE_ROOT"
    | "QUALITY_GATE_LINK_INVALID"
    | "QUALITY_GATE_CONFIG_INVALID";
  readonly message: string;
}

export function loadQualityGateConfig(repositoryRoot: string): QualityGateConfig | null {
  const configPath = resolve(repositoryRoot, ".ai-code-worker", "quality-gates.json");

  if (!existsSync(configPath)) {
    return null;
  }

  const parsed = JSON.parse(readFileSync(configPath, "utf8")) as QualityGateConfig;

  if (parsed.schemaVersion !== "1.0" || !Array.isArray(parsed.gates)) {
    throw new Error("quality-gates.json must contain schemaVersion 1.0 and gates array.");
  }

  return parsed;
}

export function resolveQualityGate(input: ResolveQualityGateInput): ResolveQualityGateResult {
  let config: QualityGateConfig | null;

  try {
    config = loadQualityGateConfig(input.repositoryRoot);
  } catch (error) {
    return blocked("QUALITY_GATE_CONFIG_INVALID", error instanceof Error ? error.message : String(error));
  }

  const definition = config?.gates.find((gate) => gate.id === input.gate);

  if (config && !definition && !/\s/.test(input.gate)) {
    return blocked("QUALITY_GATE_NOT_FOUND", `Quality gate id is not configured: ${input.gate}`);
  }

  const command = definition ? commandFromDefinition(input, definition) : commandFromString(input);

  if (!command) {
    return blocked("QUALITY_GATE_NOT_FOUND", `Quality gate is neither a configured id nor a safe command: ${input.gate}`);
  }

  return {
    status: "PASS",
    command,
    finding: null
  };
}

function commandFromDefinition(input: ResolveQualityGateInput, definition: QualityGateDefinition): CommandSpec | null {
  const cwd = resolve(input.executionRoot, definition.workingDirectory);

  if (!isPathInside(input.executionRoot, cwd)) {
    return null;
  }

  const linkedDirectories = prepareLinkedDirectories(input, definition);

  if (linkedDirectories === null) {
    return null;
  }

  return {
    id: definition.id,
    executable: definition.executable,
    args: definition.args,
    cwd,
    timeoutMs: definition.timeoutSeconds * 1000,
    maximumOutputBytes: input.maximumOutputBytes ?? 65536,
    env: allowedEnv(definition.allowedEnvironmentVariables, input.env ?? process.env),
    linkedDirectories
  };
}

function prepareLinkedDirectories(input: ResolveQualityGateInput, definition: QualityGateDefinition): CommandSpec["linkedDirectories"] | null {
  const links = definition.linkedDirectories ?? [];

  for (const link of links) {
    const source = resolve(input.repositoryRoot, link.fromRepository);
    const target = resolve(input.executionRoot, link.toWorktree);

    if (!isPathInside(input.repositoryRoot, source) || !isPathInside(input.executionRoot, target) || !existsSync(source)) {
      return null;
    }

    if (!existsSync(target)) {
      mkdirSync(dirname(target), { recursive: true });
      symlinkSync(source, target, "junction");
    }
  }

  return links.map((link) => ({
    from: resolve(input.repositoryRoot, link.fromRepository),
    to: resolve(input.executionRoot, link.toWorktree)
  }));
}

function commandFromString(input: ResolveQualityGateInput): CommandSpec | null {
  const parts = splitCommand(input.gate);

  if (!parts || parts.length === 0) {
    return null;
  }

  const [executable, ...args] = parts;

  if (!executable || executable.includes("=") || isUnsafeToken(executable)) {
    return null;
  }

  return {
    id: input.gate,
    executable,
    args,
    cwd: input.executionRoot,
    timeoutMs: input.defaultTimeoutMs,
    maximumOutputBytes: input.maximumOutputBytes ?? 65536,
    env: {}
  };
}

export function splitCommand(command: string): string[] | null {
  if (/[;&|<>`]/.test(command)) {
    return null;
  }

  const parts: string[] = [];
  let current = "";
  let quote: "'" | "\"" | null = null;

  for (let index = 0; index < command.length; index += 1) {
    const char = command[index]!;

    if ((char === "'" || char === "\"") && !quote) {
      quote = char;
      continue;
    }

    if (char === quote) {
      quote = null;
      continue;
    }

    if (/\s/.test(char) && !quote) {
      if (current.length > 0) {
        parts.push(current);
        current = "";
      }
      continue;
    }

    current += char;
  }

  if (quote) {
    return null;
  }

  if (current.length > 0) {
    parts.push(current);
  }

  return parts;
}

function allowedEnv(names: readonly string[], env: NodeJS.ProcessEnv): Readonly<Record<string, string>> {
  return Object.fromEntries(
    names.flatMap((name) => {
      const value = env[name];
      return value === undefined ? [] : [[name, value]];
    })
  );
}

function isUnsafeToken(token: string): boolean {
  return isAbsolute(token) || token.includes("\0");
}

function blocked(code: QualityGateFinding["code"], message: string): ResolveQualityGateResult {
  return {
    status: "BLOCKED",
    command: null,
    finding: { code, message }
  };
}
