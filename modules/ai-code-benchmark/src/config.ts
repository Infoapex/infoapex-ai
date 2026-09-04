import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CONFIG_VERSION, type BenchmarkConfig } from "./types.js";

export const CONFIG_DIRECTORY = ".ai-code-benchmark";
export const CONFIG_FILE = "config.json";

export function defaultConfig(): BenchmarkConfig {
  return {
    schemaVersion: CONFIG_VERSION,
    stateRoot: null,
    commands: {
      codex: ["codex"],
      claude: ["claude"],
      infoapex: ["infoapex-ai"],
      aiCodeControl: ["ai-code-control"]
    },
    capabilities: {
      liveExecution: false,
      networkExpansion: false,
      publish: false,
      secretForwarding: false
    }
  };
}

export function configPath(repositoryPath: string): string {
  return join(repositoryPath, CONFIG_DIRECTORY, CONFIG_FILE);
}

export function initConfig(repositoryPath: string, force = false): { readonly status: "CREATED" | "ALREADY_EXISTS"; readonly path: string } {
  const directory = join(repositoryPath, CONFIG_DIRECTORY);
  const path = configPath(repositoryPath);
  mkdirSync(directory, { recursive: true });
  if (existsSync(path) && !force) return { status: "ALREADY_EXISTS", path };
  writeFileSync(path, `${JSON.stringify(defaultConfig(), null, 2)}\n`, "utf8");
  return { status: "CREATED", path };
}

export function loadConfig(repositoryPath: string): BenchmarkConfig {
  const path = configPath(repositoryPath);
  if (!existsSync(path)) throw new Error(`Missing ${path}; run ai-code-benchmark init first.`);
  return parseConfig(JSON.parse(readFileSync(path, "utf8")));
}

export function parseConfig(value: unknown): BenchmarkConfig {
  if (!isRecord(value)) throw new Error("Benchmark configuration must be a JSON object.");
  assertExactKeys(value, ["schemaVersion", "stateRoot", "commands", "capabilities", "pilot"], "configuration");
  if (value.schemaVersion !== CONFIG_VERSION) throw new Error(`Unsupported configuration schemaVersion: ${String(value.schemaVersion)}`);
  if (value.stateRoot !== null && typeof value.stateRoot !== "string") throw new Error("configuration.stateRoot must be a string or null.");
  if (!isRecord(value.commands)) throw new Error("configuration.commands must be an object.");
  assertExactKeys(value.commands, ["codex", "claude", "infoapex", "aiCodeControl"], "configuration.commands");
  for (const key of ["codex", "claude", "infoapex", "aiCodeControl"] as const) {
    if (!Array.isArray(value.commands[key]) || value.commands[key].length === 0 || !value.commands[key].every((part) => typeof part === "string" && part.length > 0)) {
      throw new Error(`configuration.commands.${key} must be a non-empty string array.`);
    }
  }
  if (!isRecord(value.capabilities)) throw new Error("configuration.capabilities must be an object.");
  assertExactKeys(value.capabilities, ["liveExecution", "networkExpansion", "publish", "secretForwarding"], "configuration.capabilities");
  for (const key of ["networkExpansion", "publish", "secretForwarding"] as const) if (value.capabilities[key] !== false) throw new Error(`configuration.capabilities.${key} must remain false.`);
  if (typeof value.capabilities.liveExecution !== "boolean") throw new Error("configuration.capabilities.liveExecution must be boolean.");
  if (value.pilot !== undefined) validatePilot(value.pilot);
  if (value.capabilities.liveExecution === true && value.pilot === undefined) throw new Error("Live execution requires the complete explicit BENCH-09 pilot contract.");
  return value as unknown as BenchmarkConfig;
}

function validatePilot(value: unknown): void {
  if (!isRecord(value)) throw new Error("configuration.pilot must be an object.");
  assertExactKeys(value, ["schemaVersion", "trustedFixtureOnly", "maximumInvocations", "equalBudgets", "sharedConfigHash", "arms"], "configuration.pilot");
  if (value.schemaVersion !== "bench-09-live.v1" || value.trustedFixtureOnly !== true || value.maximumInvocations !== 30 || value.equalBudgets !== true || typeof value.sharedConfigHash !== "string" || !/^[a-f0-9]{64}$/u.test(value.sharedConfigHash)) throw new Error("configuration.pilot does not match the bounded trusted-fixture BENCH-09 contract.");
  if (!isRecord(value.arms)) throw new Error("configuration.pilot.arms must be an object.");
  assertExactKeys(value.arms, ["orchestrated-no-icm", "full-icm"], "configuration.pilot.arms");
  const b = value.arms["orchestrated-no-icm"];
  const c = value.arms["full-icm"];
  if (!isRecord(b) || !isRecord(c)) throw new Error("configuration.pilot.arms must define B and C.");
  assertExactKeys(b, ["contextProvider", "contextPackageMode"], "configuration.pilot.arms.orchestrated-no-icm");
  assertExactKeys(c, ["contextProvider", "contextPackageMode"], "configuration.pilot.arms.full-icm");
  if (b.contextProvider !== "none" || b.contextPackageMode !== "off" || c.contextProvider !== "ai-code-control" || c.contextPackageMode !== "enforce") throw new Error("configuration.pilot must preserve the public B none/off versus C ai-code-control/enforce distinction.");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertExactKeys(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) throw new Error(`${label} has unknown properties: ${unknown.join(", ")}`);
}
