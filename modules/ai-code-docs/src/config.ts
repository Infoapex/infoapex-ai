import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { assertValid } from "./schema.js";
import type { DocsConfig } from "./types.js";

export function defaultConfig(): DocsConfig {
  return {
    schemaVersion: "1.0",
    planner: ["node", "ai-code-planner/dist/src/cli.js"],
    worker: ["node", "ai-code-worker/dist/src/cli.js"],
    control: ["dotnet", "run", "--project", "ai-code-control/tools/ai-code-control/src/AiCodeControl.Cli", "--"],
    review: ["node", "ai-code-review/dist/src/cli.js"],
    defaultEngine: "codex",
    defaultReviewEngine: "codex"
  };
}

export function configPath(repositoryPath: string): string {
  return join(repositoryPath, ".ai-code-docs", "config.json");
}

export function initConfig(repositoryPath: string, force = false): { status: "CREATED" | "ALREADY_EXISTS"; path: string } {
  const path = configPath(repositoryPath);
  if (existsSync(path) && !force) return { status: "ALREADY_EXISTS", path };
  mkdirSync(join(repositoryPath, ".ai-code-docs"), { recursive: true });
  writeFileSync(path, `${JSON.stringify(defaultConfig(), null, 2)}\n`, "utf8");
  return { status: "CREATED", path };
}

export function loadConfig(repositoryPath: string): DocsConfig {
  const path = configPath(repositoryPath);
  const config = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : defaultConfig();
  assertValid("docs-config.schema.json", config);
  return config as DocsConfig;
}
