/**
 * Versioned module/capability registry (ADR-0003, P4 roadmap step 2). A data file,
 * not a plugin/discovery mechanism: adding a module or a command here is a code
 * change and a new bundle release, not something the root CLI infers at runtime -
 * see ADR-0003's "Consequences" for why that is deliberate.
 */

export type RootCommand = "doctor" | "plan" | "run" | "resume" | "review" | "docs" | "benchmark";

export interface ModuleDescriptor {
  readonly name: string;
  /** Path to the module's own built CLI entry point, relative to the bundle root.
   *  Always invoked as a subprocess (`node <cliRelativePath> ...`) - the root CLI
   *  never imports module source, per ADR-0001/ADR-0003 and the P4 exit gate. */
  readonly cliRelativePath: string;
  /** The module's own subcommand that a given root command delegates to. */
  readonly commandMap: Readonly<Partial<Record<RootCommand, string>>>;
}

export const SCHEMA_VERSION = "1.0";

export const MODULE_REGISTRY: readonly ModuleDescriptor[] = [
  {
    name: "ai-code-planner",
    cliRelativePath: "modules/ai-code-planner/dist/src/cli.js",
    commandMap: { plan: "propose" }
  },
  {
    name: "ai-code-worker",
    cliRelativePath: "modules/ai-code-worker/dist/src/cli.js",
    commandMap: { doctor: "doctor", run: "run", resume: "run" }
  },
  {
    name: "ai-code-review",
    cliRelativePath: "modules/ai-code-review/dist/src/cli.js",
    commandMap: { doctor: "doctor", review: "run" }
  },
  {
    name: "ai-code-docs",
    cliRelativePath: "modules/ai-code-docs/dist/src/cli.js",
    commandMap: { doctor: "doctor", docs: "generate" }
  },
  {
    name: "ai-code-benchmark",
    cliRelativePath: "modules/ai-code-benchmark/dist/src/cli.js",
    commandMap: { benchmark: "help" }
  }
];

/** Modules that back a given root command, in registry order. `doctor` deliberately
 *  returns more than one (aggregate); every other root command maps to exactly one. */
export function modulesForCommand(command: RootCommand): readonly ModuleDescriptor[] {
  return MODULE_REGISTRY.filter((module) => command in module.commandMap);
}

export function moduleSubcommand(module: ModuleDescriptor, command: RootCommand): string {
  const subcommand = module.commandMap[command];
  if (subcommand === undefined) {
    throw new Error(`Module '${module.name}' does not back root command '${command}'.`);
  }
  return subcommand;
}
