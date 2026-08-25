import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const TEMPLATES_ROOT = resolveTemplatesRoot();

function resolveTemplatesRoot(): string {
  // dist/src/config/shims.js -> ../../../templates/shims (repository root, same
  // relative-from-dist trick as SchemaRegistry.defaultSchemaDirectory()).
  return join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "templates", "shims");
}

export interface ShimTarget {
  readonly relativePath: string;
  readonly templateFile: string;
}

/**
 * Destinations from IMPLEMENTATION-PLAN.md §12.1/§12.2: "Fișierele `.codex/agents/*.toml`
 * și skill-ul `.agents/skills/ai-code-worker/SKILL.md` sunt generate ca shims
 * versionate" (Codex) / "Fișierele `.claude/agents/*.md` și
 * `.claude/skills/ai-code-worker/SKILL.md` sunt shims" (Claude). Both engines' skills
 * share the same content (the skill only tells the agent to shell out to the CLI),
 * copied from one template into each engine-specific location the plan documents.
 */
const SHIM_TARGETS_BY_ENGINE: Readonly<Record<string, readonly ShimTarget[]>> = {
  codex: [
    { relativePath: join(".codex", "agents", "ai-code-worker.toml"), templateFile: join("codex", "agent.toml") },
    { relativePath: join(".agents", "skills", "ai-code-worker", "SKILL.md"), templateFile: join("shared", "SKILL.md") }
  ],
  claude: [
    { relativePath: join(".claude", "agents", "ai-code-worker.md"), templateFile: join("claude", "agent.md") },
    { relativePath: join(".claude", "skills", "ai-code-worker", "SKILL.md"), templateFile: join("shared", "SKILL.md") }
  ]
};

export interface InstallShimsResult {
  readonly installed: readonly string[];
  readonly skipped: readonly string[];
}

/**
 * Optional, additive: a repository that never calls this has every shim absent and
 * `ai-code-worker run`/`doctor`/etc. behave identically either way - the CLI is
 * always the authority (IMPLEMENTATION-PLAN.md §1, §12.1, §12.2), shims are UX only.
 * Never overwrites a file that already exists (matches `init`'s own default
 * behavior) - a shim the repository owner already customized is left alone.
 */
export function installShims(repositoryRoot: string, engines: readonly string[]): InstallShimsResult {
  const installed: string[] = [];
  const skipped: string[] = [];

  for (const engine of engines) {
    const targets = SHIM_TARGETS_BY_ENGINE[engine];

    if (!targets) {
      continue;
    }

    for (const target of targets) {
      const destination = join(repositoryRoot, target.relativePath);

      if (existsSync(destination)) {
        skipped.push(target.relativePath);
        continue;
      }

      mkdirSync(dirname(destination), { recursive: true });
      writeFileSync(destination, readFileSync(join(TEMPLATES_ROOT, target.templateFile), "utf8"), "utf8");
      installed.push(target.relativePath);
    }
  }

  return { installed, skipped };
}
