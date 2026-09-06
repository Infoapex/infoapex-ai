import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { basename, dirname, join, relative, resolve } from "node:path";
import { defaultProductionPolicy } from "./production.js";

/** Technology profiles, never consumer-project names. */
export type InstallProfile = "generic" | "dotnet-nextjs";

export interface FullInstallOptions {
  readonly repositoryRoot: string;
  readonly bundleRoot: string;
  readonly profile: InstallProfile;
  /** Repository-relative layout; meaningful only to a technology profile. */
  readonly layout: { readonly backendDir: string; readonly frontendDir: string; readonly mlDir: string | null };
  /** Repair only files owned by this installer. It never touches application source. */
  readonly repair: boolean;
}

export interface FullInstallResult {
  readonly status: "DONE" | "BLOCKED";
  readonly profile: InstallProfile;
  readonly created: readonly string[];
  readonly updated: readonly string[];
  readonly skipped: readonly string[];
  readonly findings: readonly string[];
}

interface ProcessResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * P6's project-facing installation boundary.  The root owns the wiring between
 * independently runnable modules, but never imports their source.  All paths to
 * the bundle are explicit so a later bundle relocation is detected by preflight
 * instead of silently falling back to a different local installation.
 */
export function fullInstall(options: FullInstallOptions): FullInstallResult {
  const repo = resolve(options.repositoryRoot);
  const bundle = resolve(options.bundleRoot);
  const created: string[] = [];
  const updated: string[] = [];
  const skipped: string[] = [];
  const findings: string[] = [];
  for (const value of [options.layout.backendDir, options.layout.frontendDir, ...(options.layout.mlDir ? [options.layout.mlDir] : [])]) {
    if (!isSafeRelativePath(value)) findings.push(`Unsafe project layout path '${value}'. Use a repository-relative path without '..'.`);
  }
  const writeManaged = (relative: string, value: string): void => {
    const path = join(repo, relative);
    if (!existsSync(path)) {
      writeText(path, value);
      created.push(relative);
      return;
    }
    const current = readFileSync(path, "utf8");
    if (current === value) {
      skipped.push(relative);
      return;
    }
    if (!options.repair) {
      findings.push(`${relative} differs from the ${options.profile} full-install profile; rerun with --repair after reviewing it.`);
      return;
    }
    writeText(path, value);
    updated.push(relative);
  };
  const writeSeed = (relative: string, value: string): void => {
    const path = join(repo, relative);
    if (existsSync(path)) {
      skipped.push(relative);
      return;
    }
    writeText(path, value);
    created.push(relative);
  };

  const paths = modulePaths(bundle);
  writeManaged(".ai-code-control/config/code-control.json", json(controlConfig(repo, options.profile, options.layout)));
  writeManaged(".ai-code-control/config/memory-control.json", json(memoryConfig()));
  writeManaged(".ai-code-control/reports/refactor/current-plan.json", json(refactorPlan(options.profile)));
  writeSeed(".ai-code-control/memory/PROJECT-STATE.md", projectState(options.profile, options.layout));
  writeSeed(".ai-code-control/memory/DECISIONS.md", "# Decizii\n\nDeciziile aprobate se înregistrează aici cu dată, owner și motiv.\n");
  writeSeed(".ai-code-control/memory/tasks/README.md", "# Rezumate de task\n\nDupă fiecare task aprobat, adaugă un rezumat redactat: scop, fișiere, verificări și decizii.\n");
  writeSeed("TODO.md", todoSeed(options.profile));
  writeSeed("AGENTS.md", agentGuide());
  writeSeed("CLAUDE.md", claudeGuide());

  writeManaged(".ai-code-worker/config.json", json(workerConfig(paths)));
  writeManaged(".ai-code-worker/routing-policy.json", json(routingPolicy()));
  writeSeed(".ai-code-worker/README.md", "# ai-code-worker\n\nConfigurat de `infoapex-ai init --full`. Nu modifica politica de rutare fără un experiment/autorizare nouă.\n");
  writeManaged(".ai-code-review/config.json", json(reviewConfig(paths)));
  writeManaged(".ai-code-docs/config.json", json(docsConfig(paths)));
  writeManaged(".mcp.json", json(mcpConfig(repo, paths)));
  writeManaged(".claude/settings.json", json(claudeSettings(paths)));
  writeManaged(".codex/config.toml", codexConfig(repo, paths));
  writeManaged(".infoapex-ai/install-profile.json", json({
    schemaVersion: "1.0",
    profile: options.profile,
    layout: options.layout,
    bundleRoot: bundle.replaceAll("\\", "/"),
    // Deliberately deterministic: a readiness profile is configuration, not an
    // audit event. Re-running init must not manufacture a conflicting diff.
    provider: { engine: "codex", model: "gpt-5.6", reasoningEffort: "high", fallback: "disabled" },
    contextProvider: { kind: "ai-code-control", mode: "observe" }
  }));
  writeManaged(".infoapex-ai/production-policy.json", json(defaultProductionPolicy()));
  ensureRuntimeGitignore(repo, created, updated, skipped);

  // Build the C# CLI once, then invoke its DLL directly. `dotnet run` in every
  // doctor/provider call was both slow and capable of leaving compiler children
  // behind when an outer process was interrupted.
  if (findings.length === 0) {
    const build = run("dotnet", ["build", paths.controlProject, "--nologo"], repo);
    if (build.exitCode !== 0) findings.push(`ai-code-control build failed: ${boundedFailure(build)}`);
  }
  // The C# CLI creates its rebuildable SQLite caches. It does not choose a
  // template here: P6 supplied a profile-specific config above, so `api/web`
  // assumptions can never overwrite a `backend/frontend/ml` repository.
  if (findings.length === 0) {
    const init = run("dotnet", [paths.controlDll, "init", "--repo", repo], repo);
    if (init.exitCode !== 0) findings.push(`ai-code-control init failed: ${boundedFailure(init)}`);
  }

  return {
    status: findings.length === 0 ? "DONE" : "BLOCKED",
    profile: options.profile,
    created,
    updated,
    skipped,
    findings
  };
}

export interface PreflightResult {
  readonly status: "PASS" | "BLOCKED";
  readonly profile: string | null;
  readonly checks: readonly { readonly id: string; readonly status: "PASS" | "BLOCKED"; readonly detail: string }[];
}

/** Strict readiness gate: no provider is invoked; all module/process wiring is. */
export function preflight(repositoryRoot: string, bundleRoot: string): PreflightResult {
  const repo = resolve(repositoryRoot);
  const bundle = resolve(bundleRoot);
  const checks: { id: string; status: "PASS" | "BLOCKED"; detail: string }[] = [];
  const required = [
    ".infoapex-ai/config.json", ".infoapex-ai/install-profile.json", ".infoapex-ai/production-policy.json", ".ai-code-control/config/code-control.json",
    ".ai-code-control/config/memory-control.json", ".ai-code-control/memory/PROJECT-STATE.md", "TODO.md", "AGENTS.md", "CLAUDE.md",
    ".ai-code-worker/config.json", ".ai-code-worker/routing-policy.json", ".ai-code-review/config.json", ".ai-code-docs/config.json", ".mcp.json", ".claude/settings.json", ".codex/config.toml"
  ];
  const absent = required.filter((relative) => !existsSync(join(repo, relative)));
  checks.push({ id: "required-project-files", status: absent.length === 0 ? "PASS" : "BLOCKED", detail: absent.length === 0 ? "All full-install artifacts exist." : `Missing: ${absent.join(", ")}` });

  let profile: string | null = null;
  try {
    const install = JSON.parse(readFileSync(join(repo, ".infoapex-ai", "install-profile.json"), "utf8")) as Record<string, unknown>;
    profile = typeof install.profile === "string" ? install.profile : null;
    const configuredBundle = typeof install.bundleRoot === "string" ? install.bundleRoot : null;
    const expected = bundle.replaceAll("\\", "/");
    checks.push({ id: "bundle-provenance", status: configuredBundle === expected ? "PASS" : "BLOCKED", detail: configuredBundle === expected ? "Profile points to this Infoapex bundle." : "Bundle path is missing or differs; rerun full init with --repair." });
  } catch {
    checks.push({ id: "bundle-provenance", status: "BLOCKED", detail: "install-profile.json is invalid." });
  }

  try {
    const config = JSON.parse(readFileSync(join(repo, ".ai-code-worker", "config.json"), "utf8")) as Record<string, any>;
    const codex = config.adapters?.codex;
    const control = config.adapters?.aiCodeControl;
    const valid = config.contextProvider === "ai-code-control" && config.contextPackage?.mode === "observe" &&
      codex?.model === "gpt-5.6" && codex?.reasoningEffort === "high" && Array.isArray(control?.baseArgs);
    checks.push({ id: "explicit-provider-policy", status: valid ? "PASS" : "BLOCKED", detail: valid ? "Codex gpt-5.6/high is explicit; no automatic engine fallback is configured." : "Worker context/provider policy is incomplete or permits an implicit fallback." });
  } catch {
    checks.push({ id: "explicit-provider-policy", status: "BLOCKED", detail: "Worker config is invalid JSON." });
  }

  const paths = modulePaths(bundle);
  const commands: readonly { readonly id: string; readonly executable: string; readonly args: readonly string[]; readonly timeoutMs?: number }[] = [
    { id: "control-health", executable: "dotnet", args: [paths.controlDll, "health", "--json", "--repo", repo] },
    { id: "control-brief", executable: "dotnet", args: [paths.controlDll, "brief", "--json", "--task", "P6 preflight", "--repo", repo] },
    { id: "project-validation", executable: "dotnet", args: [paths.controlDll, "run-validation", "--repo", repo], timeoutMs: 1_200_000 },
    { id: "worker-doctor", executable: process.execPath, args: [paths.workerCli, "doctor", "--repo", repo, "--engine", "codex", "--json"] },
    { id: "review-doctor", executable: process.execPath, args: [paths.reviewCli, "doctor", "--repo", repo, "--engine", "codex", "--json"] },
    { id: "docs-doctor", executable: process.execPath, args: [paths.docsCli, "doctor", "--repo", repo, "--json"] }
  ];
  for (const command of commands) {
    const result = run(command.executable, command.args, repo, command.timeoutMs);
    checks.push({ id: command.id, status: result.exitCode === 0 ? "PASS" : "BLOCKED", detail: result.exitCode === 0 ? "PASS" : boundedFailure(result) });
  }
  return { status: checks.every((check) => check.status === "PASS") ? "PASS" : "BLOCKED", profile, checks };
}

function modulePaths(bundleRoot: string) {
  return {
    plannerCli: join(bundleRoot, "modules", "ai-code-planner", "dist", "src", "cli.js"),
    workerCli: join(bundleRoot, "modules", "ai-code-worker", "dist", "src", "cli.js"),
    reviewCli: join(bundleRoot, "modules", "ai-code-review", "dist", "src", "cli.js"),
    docsCli: join(bundleRoot, "modules", "ai-code-docs", "dist", "src", "cli.js"),
    controlProject: join(bundleRoot, "modules", "ai-code-control", "tools", "ai-code-control", "src", "AiCodeControl.Cli"),
    controlDll: join(bundleRoot, "modules", "ai-code-control", "tools", "ai-code-control", "src", "AiCodeControl.Cli", "bin", "Debug", "net9.0", "AiCodeControl.Cli.dll"),
    controlModuleRoot: join(bundleRoot, "modules", "ai-code-control"),
    controlMcp: join(bundleRoot, "modules", "ai-code-control", "tools", "ai-code-control", "mcp-server", "dist", "server.js")
  };
}

function workerConfig(paths: ReturnType<typeof modulePaths>) {
  return {
    schemaVersion: "1.0", contextProvider: "ai-code-control", contextPackage: { mode: "observe", maximumTokens: 12_000 }, maximumParallelWriters: 1,
    stateRoot: null, syncRootPolicy: { sequentialWriter: "block", parallelWriters: "block" },
    adapters: {
      codex: { executable: "codex", model: "gpt-5.6", reasoningEffort: "high", sandboxMode: "workspace-write", idleTimeoutSeconds: 180, maximumRuntimeSeconds: 1800, maximumRepeatedProgressEvents: 4, maximumOutputBytes: 2_000_000 },
      aiCodeControl: { executable: "dotnet", baseArgs: [paths.controlDll], timeoutSeconds: 60, maximumOutputBytes: 1_000_000 }
    }
  };
}

function routingPolicy() {
  return { schemaVersion: "1.0", policyVersion: "p6-explicit-codex-v1", profiles: {
    "mechanical-fast-v1": { candidates: [{ engine: "codex", model: "gpt-5.6" }], reason: "P6 profile pins one reviewed provider; automatic fallback is prohibited.", confidence: "high" },
    "balanced-default-v1": { candidates: [{ engine: "codex", model: "gpt-5.6" }], reason: "P6 profile pins one reviewed provider; automatic fallback is prohibited.", confidence: "high" }
  } };
}

function reviewConfig(paths: ReturnType<typeof modulePaths>) { return { schemaVersion: "1.0", planner: [process.execPath, paths.plannerCli], worker: [process.execPath, paths.workerCli], control: ["dotnet", paths.controlDll], defaultEngine: "codex" }; }
function docsConfig(paths: ReturnType<typeof modulePaths>) { return { schemaVersion: "1.0", planner: [process.execPath, paths.plannerCli], worker: [process.execPath, paths.workerCli], control: ["dotnet", paths.controlDll], review: [process.execPath, paths.reviewCli], defaultEngine: "codex", defaultReviewEngine: "codex" }; }
function mcpConfig(repo: string, paths: ReturnType<typeof modulePaths>) { return { mcpServers: { "ai-code-control": { command: process.execPath, args: [paths.controlMcp], env: { REPO_ROOT: repo, ACC_TOOL_ROOT: paths.controlModuleRoot, ACC_TOOL_TIMEOUT_MS: "300000" } } } }; }
function claudeSettings(paths: ReturnType<typeof modulePaths>) { const cli = `dotnet \"${paths.controlDll}\"`; return { hooks: { SessionStart: [{ hooks: [{ type: "command", command: `${cli} memory-brief` }] }], Stop: [{ hooks: [{ type: "command", command: `${cli} refresh` }] }] } }; }
function codexConfig(repo: string, paths: ReturnType<typeof modulePaths>) { const esc = (value: string) => value.replaceAll("\\", "/").replaceAll('"', '\\"'); return `[mcp_servers.ai-code-control]\ncommand = \"${esc(process.execPath)}\"\nargs = [\"${esc(paths.controlMcp)}\"]\ncwd = \"${esc(repo)}\"\nstartup_timeout_sec = 30\ntool_timeout_sec = 600\nrequired = false\n\n[mcp_servers.ai-code-control.env]\nREPO_ROOT = \"${esc(repo)}\"\nACC_TOOL_ROOT = \"${esc(paths.controlModuleRoot)}\"\nACC_TOOL_TIMEOUT_MS = \"300000\"\n`; }

interface ToolchainCommand { readonly name: string; readonly run: string; readonly timeoutSeconds: number }

function controlConfig(repo: string, profile: InstallProfile, layout: FullInstallOptions["layout"]) {
  const dotnet = profile === "dotnet-nextjs";
  return { toolchains: dotnet ? [
    discoveredDotnetToolchain(repo, layout.backendDir),
    discoveredNodeToolchain(repo, layout.frontendDir),
    ...(layout.mlDir ? [discoveredPythonToolchain(repo, layout.mlDir)] : [])
  ] : [{ name: "example", enabled: false, path: ".", commands: [{ name: "build", run: "echo configure-project-toolchain", timeoutSeconds: 300 }] }], git: { protectedBranches: ["main", "master", "develop", "release"], forbiddenPaths: ["node_modules/", ".next/", "dist/", "bin/", "obj/", "coverage/", ".turbo/", "generated/"] }, indexing: { database: ".ai-code-control/db/codegraph.sqlite", exclude: ["**/node_modules/**", "**/.next/**", "**/dist/**", "**/bin/**", "**/obj/**", "**/.git/**", "**/coverage/**"] }, logging: { level: "info", file: ".ai-code-control/reports/tool.log", maxFileSizeMb: 10 } };
}

function discoveredDotnetToolchain(repo: string, directory: string) {
  const root = join(repo, directory);
  const solutions = discoverFiles(root, (name) => name.endsWith(".sln") || name.endsWith(".slnx"));
  const projects = discoverFiles(root, (name) => name.endsWith(".csproj"));
  const commands: ToolchainCommand[] = [];
  if (solutions.length > 0) {
    const target = quoteCommandPath(relative(root, solutions[0]));
    commands.push({ name: "build", run: `dotnet build ${target} --nologo`, timeoutSeconds: 600 });
    commands.push({ name: "test", run: `dotnet test ${target} --nologo --no-build`, timeoutSeconds: 900 });
  } else {
    for (const project of projects) {
      const target = quoteCommandPath(relative(root, project));
      const label = commandLabel(project);
      commands.push({ name: `build-${label}`, run: `dotnet build ${target} --nologo`, timeoutSeconds: 600 });
    }
    for (const project of projects.filter(isTestProject)) {
      const target = quoteCommandPath(relative(root, project));
      commands.push({ name: `test-${commandLabel(project)}`, run: `dotnet test ${target} --nologo --no-build`, timeoutSeconds: 900 });
    }
  }
  return { name: "dotnet", enabled: commands.length > 0, path: directory, commands };
}

function discoveredNodeToolchain(repo: string, directory: string) {
  const packagePath = join(repo, directory, "package.json");
  const commands: ToolchainCommand[] = [];
  if (existsSync(packagePath)) {
    try {
      const pkg = JSON.parse(readFileSync(packagePath, "utf8")) as { scripts?: Record<string, unknown> };
      const scripts = pkg.scripts ?? {};
      for (const candidate of ["lint", "typecheck", "test", "build"] as const) {
        if (typeof scripts[candidate] === "string") {
          commands.push({ name: candidate, run: `npm run ${candidate}`, timeoutSeconds: candidate === "test" ? 900 : 600 });
        }
      }
    } catch {
      // Config validation reports malformed application manifests separately;
      // installation must never invent commands for a package it cannot parse.
    }
  }
  return { name: "node", enabled: commands.length > 0, path: directory, commands };
}

function discoveredPythonToolchain(repo: string, directory: string) {
  const root = join(repo, directory);
  const configured = ["pyproject.toml", "pytest.ini", "setup.cfg", "tox.ini"].some((name) => existsSync(join(root, name)));
  const tests = existsSync(join(root, "tests")) || discoverFiles(root, (name) => /^test_.*\.py$/i.test(name)).length > 0;
  const commands: ToolchainCommand[] = configured && tests ? [{ name: "test", run: "python -m pytest", timeoutSeconds: 900 }] : [];
  return { name: "python", enabled: commands.length > 0, path: directory, commands };
}

function discoverFiles(root: string, predicate: (name: string) => boolean): string[] {
  if (!existsSync(root)) return [];
  const result: string[] = [];
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.isDirectory() && ["bin", "obj", "node_modules", ".git", ".next"].includes(entry.name)) continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile() && predicate(entry.name.toLowerCase())) result.push(path);
    }
  };
  visit(root);
  return result.sort((left, right) => left.localeCompare(right));
}

function isTestProject(path: string): boolean { return /(?:\.tests?|test)\.csproj$/i.test(basename(path)); }
function commandLabel(path: string): string { return basename(path, ".csproj").replace(/[^a-zA-Z0-9_.-]/g, "-"); }
function quoteCommandPath(value: string): string { return `"${value.replaceAll("\\", "/").replaceAll('"', '\\"')}"`; }

function ensureRuntimeGitignore(repo: string, created: string[], updated: string[], skipped: string[]): void {
  const relativePath = ".gitignore";
  const path = join(repo, relativePath);
  const marker = "# Infoapex AI local runtime (managed)";
  const entries = [".ai-code-control/db/", ".ai-code-control/reports/tool.log", ".infoapex-ai/backups/", ".infoapex-ai/diagnostics/", ".infoapex-ai/runs/"];
  const current = existsSync(path) ? readFileSync(path, "utf8") : "";
  const missing = entries.filter((entry) => !current.split(/\r?\n/).includes(entry));
  if (missing.length === 0) {
    skipped.push(relativePath);
    return;
  }
  const prefix = current.length === 0 || current.endsWith("\n") ? current : `${current}\n`;
  const block = `${prefix.length > 0 ? "\n" : ""}${marker}\n${missing.join("\n")}\n`;
  writeText(path, `${prefix}${block}`);
  (current.length === 0 ? created : updated).push(relativePath);
}
function memoryConfig() { return { memory: { enabled: true, store: ".ai-code-control/db/memory.sqlite", root: ".ai-code-control/memory", include: [".ai-code-control/memory/**/*.md", "AGENTS.md", "CLAUDE.md", "TODO.md", ".ai-code-control/reports/refactor/**/*.json", ".ai-code-control/reports/validation/**/*.md"], exclude: ["**/secrets/**", "**/.env", "**/.env.*", "**/*.pem", "**/*.pfx", "**/*password*", "**/*secret*", "**/*token*", "**/appsettings.Production.json"], maxRecallItems: 8, maxBriefingTokens: 3000, briefCommands: null, rawConversationStorage: { enabled: false, reason: "Canonical summaries only; raw conversations can contain sensitive data." } } }; }
function refactorPlan(profile: InstallProfile) { return { task: "none", language: profile === "dotnet-nextjs" ? "csharp" : "", affectedSymbol: "", allowedFiles: [], forbiddenPaths: ["node_modules/", ".next/", ".ai-code-control/db/"], allowedUntrackedPatterns: [".ai-code-control/memory/"], requiredValidation: ["run-validation"], riskLevel: "low" }; }
function projectState(profile: InstallProfile, layout: FullInstallOptions["layout"]) { return `# Project state\n\n- Install profile: \`${profile}\`\n- Layout: backend \`${layout.backendDir}\`, frontend \`${layout.frontendDir}\`${layout.mlDir ? `, data/ML \`${layout.mlDir}\`` : ""}.\n- Architecture: document the approved application architecture before implementation.\n- Current phase: bootstrap complete; no autonomous implementation starts until P5 authorization is recorded.\n- Memory policy: update this file and a task summary after approved work; never store secrets or raw provider transcripts.\n`; }
function todoSeed(profile: InstallProfile) { return `# TODO\n\n## Bootstrap\n\n- [ ] Confirm the \`${profile}\` profile matches the repository structure.\n- [ ] Run \`infoapex-ai preflight --repo .\` and resolve every BLOCKED check.\n- [ ] Record the first approved implementation task and its P5 authorization.\n`; }
function agentGuide() { return "# Agent guide\n\nCanonical project memory is `.ai-code-control/memory/`; `TODO.md` is the visible work queue. Before an implementation task, run `infoapex-ai preflight --repo .`, inspect memory, scope the task, and obtain the required authorization. Do not switch provider/model or use a fallback without a new approved policy. After work, run validation, refresh memory/indexes and add a redacted task summary. Never persist secrets or raw conversations.\n"; }
function claudeGuide() { return "# Claude Code bootstrap\n\nRead `AGENTS.md`, `TODO.md`, and `.ai-code-control/memory/PROJECT-STATE.md` before changing code. This repository is governed by Infoapex AI; its configured provider policy must not be bypassed.\n"; }
function json(value: unknown): string { return `${JSON.stringify(value, null, 2)}\n`; }
function writeText(path: string, value: string): void { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, value, "utf8"); }
function run(executable: string, args: readonly string[], cwd: string, timeoutMs = 120_000): ProcessResult { const result = spawnSync(executable, args, { cwd, encoding: "utf8", windowsHide: true, timeout: timeoutMs }); return { exitCode: result.status ?? 1, stdout: result.stdout ?? "", stderr: result.stderr ?? (result.error?.message ?? "") }; }
function boundedFailure(result: ProcessResult): string { return (result.stderr || result.stdout || `exit ${result.exitCode}`).trim().replace(/\s+/g, " ").slice(-1000); }
function isSafeRelativePath(value: string): boolean { return value.length > 0 && !value.includes("..") && !value.startsWith("/") && !/^[a-zA-Z]:/.test(value) && !value.includes("\\"); }
