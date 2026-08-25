import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const CONFIG_TEMPLATE_VERSION = "1.0";

/**
 * Default `.ai-code-worker/config.json` content for a freshly-initialized
 * repository. Deliberately limited to fields `loadProjectConfig()` actually reads
 * today (`src/config/project-config.ts`) - the fuller shape documented in
 * IMPLEMENTATION-PLAN.md §6 (baseBranch, integrationBranchPrefix, ...) is aspirational
 * and not wired into any runtime code yet, so scaffolding those keys now would create
 * config that looks authoritative but does nothing.
 */
export function defaultProjectConfigTemplate(): Readonly<Record<string, unknown>> {
  return {
    schemaVersion: CONFIG_TEMPLATE_VERSION,
    contextProvider: "none",
    maximumParallelWriters: 2,
    stateRoot: null,
    syncRootPolicy: {
      sequentialWriter: "warn",
      parallelWriters: "block"
    }
  };
}

/**
 * `--engines codex,claude` (IMPLEMENTATION-PLAN.md §5.1) scaffolds an empty stub
 * under `adapters.<engine>` per requested engine, so a first `doctor` run has
 * somewhere obvious to add `executable`/`testedVersionRanges` overrides. Executables
 * are discovered dynamically by default; every
 * field on `AdapterProjectConfig` is optional, so `{}` is a valid, harmless stub.
 */
function withEngineStubs(template: Readonly<Record<string, unknown>>, engines: readonly string[]): Readonly<Record<string, unknown>> {
  if (engines.length === 0) {
    return template;
  }

  const adapters: Record<string, unknown> = {};
  for (const engine of engines) {
    adapters[engine] = {};
  }

  return { ...template, adapters };
}

const README_CONTENT = `# .ai-code-worker

This directory is managed by \`ai-code-worker init\`/\`ai-code-worker update\`.

- \`config.json\` - project-level configuration (engine defaults, context provider,
  parallelism, state root, sync-root policy). Keys you add or change here are
  preserved by \`update\`; only keys missing from your file are ever added.
- Run \`ai-code-worker update\` after upgrading ai-code-worker to pick up new
  default config keys without losing your customizations.
`;

const ROUTING_POLICY_TEMPLATE = {
  schemaVersion: "1.0",
  policyVersion: "local-1",
  profiles: {
    "mechanical-fast-v1": {
      candidates: [
        { engine: "codex", model: null },
        { engine: "claude", model: null }
      ],
      reason: "Prefer the configured fast coding engine, then use the alternate engine only when it is unavailable.",
      confidence: "medium"
    },
    "balanced-default-v1": {
      candidates: [
        { engine: "codex", model: null },
        { engine: "claude", model: null }
      ],
      reason: "Use the local default engine configuration with a bounded availability fallback.",
      confidence: "low"
    }
  }
};

export interface InitProjectConfigOptions {
  readonly force?: boolean;
  readonly engines?: readonly string[];
}

export type InitProjectConfigResult =
  | { readonly status: "CREATED"; readonly configPath: string; readonly readmePath: string }
  | { readonly status: "ALREADY_EXISTS"; readonly configPath: string };

export function initProjectConfig(repositoryRoot: string, options: InitProjectConfigOptions = {}): InitProjectConfigResult {
  const dir = join(repositoryRoot, ".ai-code-worker");
  const configPath = join(dir, "config.json");

  if (existsSync(configPath) && !options.force) {
    return { status: "ALREADY_EXISTS", configPath };
  }

  mkdirSync(dir, { recursive: true });
  const template = withEngineStubs(defaultProjectConfigTemplate(), options.engines ?? []);
  writeFileSync(configPath, `${JSON.stringify(template, null, 2)}\n`, "utf8");
  const readmePath = join(dir, "README.md");
  writeFileSync(readmePath, README_CONTENT, "utf8");
  const routingPolicyPath = join(dir, "routing-policy.json");
  writeFileSync(routingPolicyPath, `${JSON.stringify(ROUTING_POLICY_TEMPLATE, null, 2)}\n`, "utf8");

  return { status: "CREATED", configPath, readmePath };
}

export interface UpdateProjectConfigResult {
  readonly status: "UPDATED" | "UNCHANGED" | "MISSING";
  readonly configPath: string;
  readonly addedKeys: readonly string[];
}

/**
 * Additive-only merge: any top-level key present in the default template but
 * absent from the repository's existing config.json is added with its default
 * value. Every key already present - regardless of its value - is left exactly
 * as the repository has it, including keys whose *shape* predates a newer
 * default (e.g. an older `syncRootPolicy`). That's a deliberate, honest
 * simplification for this stage: a deep/shape-aware merge could silently
 * change behavior the repository owner chose on purpose.
 */
export function updateProjectConfig(repositoryRoot: string): UpdateProjectConfigResult {
  const configPath = join(repositoryRoot, ".ai-code-worker", "config.json");

  if (!existsSync(configPath)) {
    return { status: "MISSING", configPath, addedKeys: [] };
  }

  const existing = JSON.parse(readFileSync(configPath, "utf8")) as Record<string, unknown>;
  const template = defaultProjectConfigTemplate();
  const addedKeys: string[] = [];
  const merged: Record<string, unknown> = { ...existing };

  for (const [key, value] of Object.entries(template)) {
    if (!(key in existing)) {
      merged[key] = value;
      addedKeys.push(key);
    }
  }

  if (addedKeys.length === 0) {
    return { status: "UNCHANGED", configPath, addedKeys: [] };
  }

  writeFileSync(configPath, `${JSON.stringify(merged, null, 2)}\n`, "utf8");

  return { status: "UPDATED", configPath, addedKeys };
}
