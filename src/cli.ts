#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { delegate, type RootEnvelope } from "./delegate.js";
import { fullInstall, preflight, type InstallProfile } from "./full-install.js";
import { explainConfig, migrate, rollbackConfig, validateConfig } from "./config-lifecycle.js";
import { checkInstall, rollbackRelease, upgrade } from "./release-lifecycle.js";
import { acquireLease, diagnosticsBundle, productionDoctor, productionHealth, retention } from "./production.js";
import { buildEvidenceView } from "./evidence-viewer.js";
import { MODULE_REGISTRY, modulesForCommand, moduleSubcommand, type RootCommand } from "./registry.js";

interface CommandHelp {
  readonly usage: string;
  readonly summary: string;
  readonly delegatesTo: string | null;
}

/** One entry per root command (ADR-0003 roadmap item 6: "Help, diagnostic și erori
 *  coerente"). Kept here, not in registry.ts, because it is presentation text for a
 *  human reading `infoapex-ai help` - the registry's job is machine-readable command
 *  ownership, not prose. A delegated command's own required/optional flags are not
 *  restated here: they are the target module's contract, and an incomplete invocation
 *  already surfaces that module's own usage message inside the BLOCKED envelope. */
const COMMAND_HELP: Readonly<Record<string, CommandHelp>> = {
  init: { usage: "infoapex-ai init --repo <path> [--mode independent|integrated] [--full --profile generic|dotnet-nextjs] [--backend-dir <dir> --frontend-dir <dir> --ml-dir <dir>] [--execution-profile <file>] [--repair] [--verify]", summary: "Bootstrap handoff only, or install a reusable P6 technology profile with --full; --execution-profile imports a schema-validated provider/isolation profile; --verify runs the no-provider readiness gate after installation.", delegatesTo: null },
  install: { usage: "infoapex-ai install --check --repo <path>", summary: "Check an existing full installation and the active bundle without changing it.", delegatesTo: null },
  upgrade: { usage: "infoapex-ai upgrade [--check] --repo <path>", summary: "Back up installer-owned files and retarget a full installation to this bundle.", delegatesTo: null },
  preflight: { usage: "infoapex-ai preflight --repo <path>", summary: "Run the strict no-provider readiness gate for a full installation.", delegatesTo: null },
  config: { usage: "infoapex-ai config <validate|explain> --repo <path>", summary: "Validate or explain installer-owned configuration without changing it.", delegatesTo: null },
  migrate: { usage: "infoapex-ai migrate <--check|--dry-run|--apply> --repo <path>", summary: "Validate, back up, and journal an idempotent configuration migration.", delegatesTo: null },
  rollback: { usage: "infoapex-ai rollback --repo <path> [--migration config-v1] [--release [--upgrade-id <id>]] [--dry-run]", summary: "Restore a verified configuration migration or release-upgrade backup.", delegatesTo: null },
  production: { usage: "infoapex-ai production <doctor|health|lease|retention> --repo <path> [--apply]", summary: "Report bounded local health, verify policy, acquire one lease, or inspect/apply evidence retention.", delegatesTo: null },
  diagnostics: { usage: "infoapex-ai diagnostics bundle --repo <path> [--out <relative-path>]", summary: "Explicitly create a local, redacted, size-bounded support bundle; it is never uploaded.", delegatesTo: null },
  ui: { usage: "infoapex-ai ui --repo <path> [--run-id <id>] [--out <relative-path>]", summary: "Render a static, local, read-only HTML summary of bounded run evidence.", delegatesTo: null },
  status: { usage: "infoapex-ai status --repo <path>", summary: "Report this repository's integration mode and each vendored module's pinned commit. Not run state - see 'resume' for that.", delegatesTo: null },
  handoff: { usage: "infoapex-ai handoff --repo <path> --direction <planner-to-worker|worker-to-planner> --run-id <id> --payload <json>", summary: "Publish a versioned handoff file between planner and worker (integrated mode only).", delegatesTo: null },
  doctor: { usage: "infoapex-ai doctor --repo <path> [module flags...]", summary: "Aggregate: run doctor on every module present (ai-code-worker, ai-code-review, ai-code-docs) and report the worst status.", delegatesTo: "ai-code-worker, ai-code-review, ai-code-docs (doctor)" },
  plan: { usage: "infoapex-ai plan <prompt> --repo <path> [--out <path>]", summary: "Produce a draft task plan. Does not chain into inspect/compile - those stay separate, human-reviewed steps.", delegatesTo: "ai-code-planner (propose)" },
  run: { usage: "infoapex-ai run --repo <path> --plan <path> --engine <fake|codex|claude> [--run-id <id>]", summary: "Execute an accepted plan.", delegatesTo: "ai-code-worker (run)" },
  resume: { usage: "infoapex-ai resume --repo <path> --run-id <id> --plan <path> --engine <fake|codex|claude>", summary: "Continue a run that has already started. Rejects with RUN_NOT_FOUND if --run-id does not match an existing run, rather than silently starting a new one.", delegatesTo: "ai-code-worker (status, then run)" },
  review: { usage: "infoapex-ai review --repo <path> --request <path> [--no-planner] [--no-control]", summary: "Run an independent, read-only review against accepted criteria.", delegatesTo: "ai-code-review (run)" },
  docs: { usage: "infoapex-ai docs --repo <path> --request <path>", summary: "Generate documentation through the planner -> worker -> review cycle.", delegatesTo: "ai-code-docs (generate)" },
  benchmark: { usage: "infoapex-ai benchmark <subcommand> [module flags...]", summary: "Run the independent benchmark module; its subcommands and flags are forwarded unchanged.", delegatesTo: "ai-code-benchmark (<subcommand>)" }
};

function printHelp(): void {
  const lines: string[] = [
    "infoapex-ai - local governance layer over Codex CLI / Claude Code coding agents",
    "",
    "Usage: infoapex-ai <command> [flags...]",
    "",
    "Commands:"
  ];
  for (const [name, help] of Object.entries(COMMAND_HELP)) {
    lines.push(`  ${name}`);
    lines.push(`    ${help.usage}`);
    lines.push(`    ${help.summary}`);
    if (help.delegatesTo) {
      lines.push(`    Delegates to: ${help.delegatesTo}`);
    }
    lines.push("");
  }
  lines.push("Every delegated command (doctor/plan/run/resume/review/docs/benchmark) spawns the target");
  lines.push("module's own built CLI as a subprocess and normalizes its result into");
  lines.push("{schemaVersion, command, module, status, exitCode, body} - see");
  lines.push("docs/adr/0003-unified-root-cli-delegation.md for the full contract.");
  console.log(lines.join("\n"));
}

const args = process.argv.slice(2);
const command = args[0];
const DELEGATED_COMMANDS: readonly RootCommand[] = ["doctor", "plan", "run", "resume", "review", "docs", "benchmark"];

if (command === "help" || command === "--help" || command === "-h") {
  printHelp();
  process.exitCode = 0;
} else if (command === "init") {
  const repo = resolve(option("--repo") ?? process.cwd());
  const mode = option("--mode") ?? "independent";
  if (mode !== "independent" && mode !== "integrated") {
    fail("--mode must be independent or integrated");
  }
  const apexRoot = join(repo, ".infoapex-ai");
  const handoffRoot = join(apexRoot, "runs");
  const config = {
    schemaVersion: "1.0",
    mode,
    handoffRoot: relativePath(repo, handoffRoot),
    planner: { enabled: mode === "integrated" },
    worker: { enabled: mode === "integrated" }
  };
  const repair = args.includes("--repair");
  const bootstrapConflict = existingBootstrapConflict(apexRoot, config, mode, repair);
  if (bootstrapConflict !== null) {
    console.log(JSON.stringify({ status: "BLOCKED", mode, created: [], updated: [], skipped: [], findings: [bootstrapConflict], configPath: join(apexRoot, "config.json"), handoffRoot }, null, 2));
    process.exitCode = 2;
  } else if (args.includes("--full")) {
    const profile = option("--profile") ?? "generic";
    if (profile !== "generic" && profile !== "dotnet-nextjs") {
      fail("--profile must be generic or dotnet-nextjs");
    }
    const result = fullInstall({ repositoryRoot: repo, bundleRoot: bundleRoot(), profile: profile as InstallProfile, repair, executionProfilePath: option("--execution-profile") ?? undefined, layout: { backendDir: option("--backend-dir") ?? "backend", frontendDir: option("--frontend-dir") ?? "frontend", mlDir: option("--ml-dir") ?? "ml" } });
    if (result.status === "DONE") {
      mkdirSync(handoffRoot, { recursive: true });
      writeBootstrap(apexRoot, config, mode, repair);
    }
    const verification = result.status === "DONE" && args.includes("--verify") ? preflight(repo, bundleRoot()) : null;
    const finalStatus = verification?.status === "BLOCKED" ? "BLOCKED" : result.status;
    console.log(JSON.stringify({ ...result, status: finalStatus, mode, configPath: join(apexRoot, "config.json"), handoffRoot, ...(verification === null ? {} : { postInstallVerification: verification }) }, null, 2));
    process.exitCode = finalStatus === "DONE" ? 0 : 2;
  } else {
    mkdirSync(handoffRoot, { recursive: true });
    writeBootstrap(apexRoot, config, mode, repair);
    console.log(JSON.stringify({ status: "DONE", mode, configPath: join(apexRoot, "config.json"), handoffRoot }, null, 2));
    process.exitCode = 0;
  }
} else if (command === "preflight") {
  const repo = resolve(option("--repo") ?? process.cwd());
  const result = preflight(repo, bundleRoot());
  console.log(JSON.stringify(result, null, 2));
  process.exitCode = result.status === "PASS" ? 0 : 2;
} else if (command === "install") {
  if (!args.includes("--check")) fail("Usage: infoapex-ai install --check --repo <path>");
  const repo = resolve(option("--repo") ?? process.cwd());
  const result = checkInstall(repo, bundleRoot());
  console.log(JSON.stringify(result, null, 2));
  process.exitCode = result.status === "PASS" ? 0 : 2;
} else if (command === "upgrade") {
  const repo = resolve(option("--repo") ?? process.cwd());
  const result = args.includes("--check") ? checkInstall(repo, bundleRoot(), false) : upgrade(repo, bundleRoot());
  console.log(JSON.stringify(result, null, 2));
  process.exitCode = result.status === "PASS" ? 0 : 2;
} else if (command === "config") {
  const repo = resolve(option("--repo") ?? process.cwd());
  const subcommand = args[1];
  if (subcommand === "validate") {
    const result = validateConfig(repo); console.log(JSON.stringify(result, null, 2)); process.exitCode = result.status === "PASS" ? 0 : 2;
  } else if (subcommand === "explain") {
    const result = explainConfig(repo); console.log(JSON.stringify(result, null, 2)); process.exitCode = result.status === "PASS" ? 0 : 2;
  } else fail("Usage: infoapex-ai config <validate|explain> --repo <path>");
} else if (command === "migrate") {
  const repo = resolve(option("--repo") ?? process.cwd());
  const modes = ["--check", "--dry-run", "--apply"].filter((flag) => args.includes(flag));
  if (modes.length !== 1) fail("Usage: infoapex-ai migrate <--check|--dry-run|--apply> --repo <path>");
  const selected = modes[0] === "--apply" ? "apply" : modes[0] === "--dry-run" ? "dry-run" : "check";
  const result = migrate(repo, selected); console.log(JSON.stringify(result, null, 2)); process.exitCode = result.status === "PASS" ? 0 : 2;
} else if (command === "rollback") {
  const repo = resolve(option("--repo") ?? process.cwd());
  const result = args.includes("--release")
    ? rollbackRelease(repo, option("--upgrade-id") ?? null, args.includes("--dry-run"))
    : rollbackConfig(repo, option("--migration") ?? "config-v1", args.includes("--dry-run"));
  console.log(JSON.stringify(result, null, 2)); process.exitCode = result.status === "PASS" ? 0 : 2;
} else if (command === "production") {
  const repo = resolve(option("--repo") ?? process.cwd()); const subcommand = args[1];
  const result = subcommand === "doctor" ? productionDoctor(repo) : subcommand === "health" ? productionHealth(repo) : subcommand === "lease" ? acquireLease(repo, option("--run-id") ?? randomUUID()) : subcommand === "retention" ? retention(repo, args.includes("--apply") ? false : true) : null;
  if (!result) fail("Usage: infoapex-ai production <doctor|health|lease|retention> --repo <path> [--apply]");
  console.log(JSON.stringify(result, null, 2)); process.exitCode = result.status === "PASS" ? 0 : 2;
} else if (command === "diagnostics") {
  if (args[1] !== "bundle") fail("Usage: infoapex-ai diagnostics bundle --repo <path> [--out <relative-path>]");
  const repo = resolve(option("--repo") ?? process.cwd()); const result = diagnosticsBundle(repo, option("--out") ?? undefined);
  console.log(JSON.stringify(result, null, 2)); process.exitCode = result.status === "PASS" ? 0 : 2;
} else if (command === "ui") {
  const repo = resolve(option("--repo") ?? process.cwd());
  const result = buildEvidenceView(repo, option("--run-id"));
  if (result.status === "BLOCKED") {
    console.log(JSON.stringify(result, null, 2));
    process.exitCode = 2;
  } else if (option("--out")) {
    const output = resolve(repo, option("--out")!);
    if (output === repo || !output.startsWith(`${repo}\\`)) fail("--out must be a file inside --repo");
    writeText(output, result.html!);
    console.log(JSON.stringify({ status: "PASS", output, runCount: result.runCount, runIds: result.runIds }, null, 2));
    process.exitCode = 0;
  } else {
    process.stdout.write(result.html!);
    process.exitCode = 0;
  }
} else if (command === "status") {
  const repo = resolve(option("--repo") ?? process.cwd());
  const path = join(repo, ".infoapex-ai", "config.json");
  const modules = readPinnedModuleVersions();
  if (!existsSync(path)) {
    console.log(JSON.stringify({ status: "INDEPENDENT", configured: false, modules }, null, 2));
    process.exitCode = 0;
  } else {
    console.log(JSON.stringify({ status: "DONE", configured: true, config: JSON.parse(readFileSync(path, "utf8")), modules }, null, 2));
  }
} else if (command === "handoff") {
  const repo = resolve(option("--repo") ?? process.cwd());
  const direction = option("--direction");
  const runId = option("--run-id");
  const payloadPath = option("--payload");
  if ((direction !== "planner-to-worker" && direction !== "worker-to-planner") || !runId || !payloadPath) {
    fail("Usage: infoapex-ai handoff --direction <planner-to-worker|worker-to-planner> --run-id <id> --payload <json>");
  }
  const config = readConfig(repo);
  if (config.mode !== "integrated") {
    fail("Integration is disabled. Run infoapex-ai init --mode integrated first.");
  }
  const payload = JSON.parse(readFileSync(resolve(repo, payloadPath!), "utf8"));
  const handoff = {
    schemaVersion: "1.0",
    handoffId: randomUUID(),
    direction,
    createdAt: new Date().toISOString(),
    runId,
    payload
  };
  const output = join(repo, config.handoffRoot, runId!, `${direction}.json`);
  writeJson(output, handoff);
  console.log(JSON.stringify({ status: "DONE", output }, null, 2));
} else if (command === "doctor") {
  // Aggregate (ADR-0003): every module that has its own `doctor` gets a fan-out call
  // with the same forwarded args; the combined status is the worst of all of them,
  // so one unavailable/misconfigured module blocks the aggregate result rather than
  // being silently skipped.
  const forwardedArgs = args.slice(1);
  const results = modulesForCommand("doctor").map((module) =>
    delegate({ command: "doctor", module, subcommand: moduleSubcommand(module, "doctor"), bundleRoot: bundleRoot(), args: forwardedArgs })
  );
  printAggregate("doctor", results);
} else if (isDelegatedSingleModuleCommand(command)) {
  const forwardedArgs = args.slice(1);
  const modules = modulesForCommand(command);
  const module = modules[0];
  if (!module) {
    fail(`No module is registered for root command '${command}'.`);
  }
  if (command === "resume") {
    printEnvelope(runResume(module!, forwardedArgs));
  } else {
    // `benchmark` is a namespace command: unlike the other root verbs, its first
    // forwarded token is the benchmark module's own subcommand. The registry uses
    // an empty prefix so root forwards it verbatim rather than reimplementing that
    // CLI's public surface. Its mapped `help` command is only the no-subcommand
    // default; a supplied subcommand is always forwarded unchanged.
    const subcommand = command === "benchmark"
      ? forwardedArgs[0] ?? moduleSubcommand(module!, command)
      : moduleSubcommand(module!, command);
    const moduleArgs = command === "benchmark" ? forwardedArgs.slice(1) : forwardedArgs;
    printEnvelope(delegate({ command, module: module!, subcommand, bundleRoot: bundleRoot(), args: moduleArgs }));
  }
} else {
  console.error(`Usage: infoapex-ai <init|install|upgrade|preflight|config|migrate|rollback|production|diagnostics|ui|status|handoff|${DELEGATED_COMMANDS.join("|")}>. Run 'infoapex-ai help' for details on each command.`);
  process.exitCode = 1;
}

function option(name: string): string | null {
  return readForwardedOption(args, name);
}

function readForwardedOption(from: readonly string[], name: string): string | null {
  const index = from.indexOf(name);
  return index < 0 ? null : from[index + 1] ?? null;
}

function isDelegatedSingleModuleCommand(value: string | undefined): value is "plan" | "run" | "resume" | "review" | "docs" | "benchmark" {
  return value === "plan" || value === "run" || value === "resume" || value === "review" || value === "docs" || value === "benchmark";
}

function bundleRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
}

function printEnvelope(envelope: RootEnvelope): void {
  console.log(JSON.stringify(envelope, null, 2));
  process.exitCode = envelope.exitCode;
}

function printAggregate(command: RootCommand, results: readonly RootEnvelope[]): void {
  const status = results.some((result) => result.status === "BLOCKED")
    ? "BLOCKED"
    : results.some((result) => result.status === "WARN")
      ? "WARN"
      : "PASS";
  const exitCode = results.reduce((worst, result) => Math.max(worst, result.exitCode), 0);
  const modules: Record<string, RootEnvelope> = {};
  for (const result of results) {
    modules[result.module ?? "unknown"] = result;
  }
  console.log(JSON.stringify({ schemaVersion: "1.0", command, status, exitCode, modules }, null, 2));
  process.exitCode = exitCode;
}

/** `resume` (ADR-0003) requires --run-id explicitly and checks the run actually
 *  exists via the module's own `status` subcommand before delegating to `run` -
 *  unlike `run` itself, where omitting --run-id just starts a fresh one. This is
 *  what stops "resume" from silently starting a new run under a typo'd id. */
function runResume(module: (typeof MODULE_REGISTRY)[number], forwardedArgs: readonly string[]): RootEnvelope {
  const runId = readForwardedOption(forwardedArgs, "--run-id");
  if (!runId) {
    fail("Usage: infoapex-ai resume --repo <path> --run-id <id> --plan <path> [--engine fake|codex|claude ...]");
  }
  const repo = readForwardedOption(forwardedArgs, "--repo") ?? process.cwd();
  const statusEnvelope = delegate({
    command: "resume",
    module,
    subcommand: "status",
    bundleRoot: bundleRoot(),
    args: ["--repo", repo, "--run-id", runId!]
  });
  const runStatus = readRunStatus(statusEnvelope.body);
  if (runStatus === "EMPTY" || runStatus === null) {
    return {
      schemaVersion: "1.0",
      command: "resume",
      module: module.name,
      status: "BLOCKED",
      exitCode: 2,
      body: {
        findings: [
          {
            severity: "blocker",
            code: "RUN_NOT_FOUND",
            message: `No existing run '${runId}' found for --repo ${repo}. 'resume' only continues a run that has already started - use 'run' to start a new one.`
          }
        ]
      }
    };
  }
  return delegate({ command: "resume", module, subcommand: "run", bundleRoot: bundleRoot(), args: forwardedArgs });
}

function readRunStatus(body: unknown): string | null {
  if (body && typeof body === "object" && "run" in body) {
    const run = (body as { run?: unknown }).run;
    if (run && typeof run === "object" && "status" in run) {
      const status = (run as { status?: unknown }).status;
      return typeof status === "string" ? status : null;
    }
  }
  return null;
}

interface PinnedModuleVersion {
  readonly name: string;
  readonly sourceCommit: string | null;
  readonly sourceRepository: string;
  readonly provenanceStatus?: "published" | "local-candidate-unpublished";
  readonly publicationGate?: string;
}

/** Reports the pinned upstream commit for each vendored module (P3 exit-gate item:
 *  "toate modulele raportează versiunile fixate" - docs/plans/INFOAPEX-AI-ROADMAP-P0-P5.md
 *  §7). Reads `modules/provenance.json` relative to THIS installed bundle's own root, not
 *  the target `--repo` - provenance is a fact about the bundle you're running, not
 *  something a target repository declares. Best-effort: a bundle that somehow lacks the
 *  file (e.g. a stripped-down fork) reports an empty list rather than crashing `status`. */
function readPinnedModuleVersions(): readonly PinnedModuleVersion[] {
  const path = join(bundleRoot(), "modules", "provenance.json");
  if (!existsSync(path)) {
    return [];
  }
  try {
    const provenance = JSON.parse(readFileSync(path, "utf8")) as { modules?: readonly PinnedModuleVersion[] };
    return (provenance.modules ?? []).map((entry) => ({
      name: entry.name,
      sourceCommit: entry.sourceCommit,
      sourceRepository: entry.sourceRepository,
      ...(entry.provenanceStatus ? { provenanceStatus: entry.provenanceStatus } : {}),
      ...(entry.publicationGate ? { publicationGate: entry.publicationGate } : {})
    }));
  } catch {
    return [];
  }
}

function readConfig(repo: string): { mode: "independent" | "integrated"; handoffRoot: string } {
  const path = join(repo, ".infoapex-ai", "config.json");
  if (!existsSync(path)) {
    fail("infoapex-ai is not initialized for this repository");
  }
  return JSON.parse(readFileSync(path, "utf8")) as { mode: "independent" | "integrated"; handoffRoot: string };
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function writeText(path: string, value: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, value, "utf8");
}

function relativePath(from: string, to: string): string {
  const value = resolve(to).replace(resolve(from), "").replaceAll("\\", "/");
  return value.startsWith("/") ? value.slice(1) : value;
}

function existingBootstrapConflict(apexRoot: string, config: unknown, mode: string, repair: boolean): string | null {
  if (repair) return null;
  const expectedFiles = [
    ["config.json", `${JSON.stringify(config, null, 2)}\n`],
    ["README.md", bootstrapReadme(mode)]
  ] as const;
  for (const [name, expected] of expectedFiles) {
    const path = join(apexRoot, name);
    if (!existsSync(path)) continue;
    try {
      if (readFileSync(path, "utf8") !== expected) return `.infoapex-ai/${name} differs from the requested bootstrap; rerun full init with --repair after reviewing it.`;
    } catch {
      return `.infoapex-ai/${name} is unreadable; rerun full init with --repair after reviewing it.`;
    }
  }
  return null;
}

function writeBootstrap(apexRoot: string, config: unknown, mode: string, repair: boolean): void {
  for (const [name, value] of [["config.json", `${JSON.stringify(config, null, 2)}\n`], ["README.md", bootstrapReadme(mode)]] as const) {
    const path = join(apexRoot, name);
    if (repair || !existsSync(path)) writeText(path, value);
  }
}

function bootstrapReadme(mode: string): string {
  return `# infoapex-ai integration\n\nMode: ${mode}\n\nManaged by infoapex-ai init. The modules remain independently runnable.\n`;
}

function fail(message: string): never {
  console.error(JSON.stringify({ status: "BLOCKED", error: message }));
  process.exit(1);
}
