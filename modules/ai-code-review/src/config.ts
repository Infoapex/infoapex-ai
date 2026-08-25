import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ReviewConfig } from "./types.js";
import { assertValid } from "./schema.js";

export const CONFIG_DIR = ".ai-code-review";
export const CONFIG_FILE = join(CONFIG_DIR, "config.json");

export function defaultConfig(): ReviewConfig {
  return {
    schemaVersion: "1.0",
    planner: ["node", "ai-code-planner/dist/src/cli.js"],
    worker: ["node", "ai-code-worker/dist/src/cli.js"],
    control: ["dotnet", "run", "--project", "ai-code-control/tools/ai-code-control/src/AiCodeControl.Cli", "--"],
    defaultEngine: "codex"
  };
}

export function initConfig(repositoryPath: string, force = false): { readonly status: "CREATED" | "ALREADY_EXISTS"; readonly path: string } {
  const directory = join(repositoryPath, CONFIG_DIR);
  const path = join(repositoryPath, CONFIG_FILE);
  mkdirSync(directory, { recursive: true });
  if (existsSync(path) && !force) return { status: "ALREADY_EXISTS", path };
  writeFileSync(path, `${JSON.stringify(defaultConfig(), null, 2)}\n`, "utf8");
  return { status: "CREATED", path };
}

export function loadConfig(repositoryPath: string): ReviewConfig {
  const path = join(repositoryPath, CONFIG_FILE);
  if (!existsSync(path)) throw new Error(`Missing ${path}; run ai-code-review init first.`);
  const config = JSON.parse(readFileSync(path, "utf8")) as ReviewConfig;
  assertValid("review-config.schema.json", config);
  return config;
}
