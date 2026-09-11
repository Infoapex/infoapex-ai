import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fullInstall, type InstallProfile } from "./full-install.js";
import { validateConfig } from "./config-lifecycle.js";

const RUNTIME_PATHS = [
  "dist/src/cli.js",
  "modules/ai-code-planner/dist/src/cli.js",
  "modules/ai-code-worker/dist/src/cli.js",
  "modules/ai-code-review/dist/src/cli.js",
  "modules/ai-code-docs/dist/src/cli.js",
  "modules/ai-code-benchmark/dist/src/cli.js",
  "modules/ai-code-control/tools/ai-code-control/mcp-server/dist/server.js",
  "modules/ai-code-control/tools/ai-code-control/src/AiCodeControl.Cli/AiCodeControl.Cli.csproj",
  "modules/provenance.json"
] as const;

const UPGRADE_PATHS = [
  ".ai-code-control/config/code-control.json",
  ".ai-code-control/config/memory-control.json",
  ".ai-code-control/reports/refactor/current-plan.json",
  ".ai-code-worker/config.json",
  ".ai-code-worker/routing-policy.json",
  ".ai-code-review/config.json",
  ".ai-code-docs/config.json",
  ".mcp.json",
  ".claude/settings.json",
  ".codex/config.toml",
  ".infoapex-ai/install-profile.json",
  ".infoapex-ai/production-policy.json",
  ".gitignore"
] as const;

export interface LifecycleCheck {
  readonly status: "PASS" | "BLOCKED";
  readonly profile: InstallProfile | null;
  readonly checks: readonly { readonly id: string; readonly status: "PASS" | "BLOCKED"; readonly detail: string }[];
}

interface InstallProfileRecord {
  readonly schemaVersion: "1.0";
  readonly profile: InstallProfile;
  readonly bundleRoot: string;
  readonly layout: { readonly backendDir: string; readonly frontendDir: string; readonly mlDir: string | null };
}

interface JournalEntry {
  readonly path: string;
  readonly existed: boolean;
  readonly sha256: string | null;
  readonly backupSha256: string | null;
  readonly postUpgradeSha256?: string | null;
}

interface UpgradeJournal {
  readonly schemaVersion: "1.0";
  readonly upgradeId: string;
  readonly status: "PREPARED" | "APPLIED" | "FAILED" | "ROLLED_BACK";
  readonly createdAt: string;
  readonly appliedAt?: string;
  readonly rolledBackAt?: string;
  readonly bundleRoot: string;
  readonly previousBundleRoot: string;
  readonly profile: InstallProfile;
  readonly layout: InstallProfileRecord["layout"];
  readonly backupRoot: string;
  readonly entries: readonly JournalEntry[];
  readonly installResult?: unknown;
}

export function checkInstall(repositoryRoot: string, bundleRoot: string, requireCurrentBundle = true): LifecycleCheck {
  const repo = resolve(repositoryRoot);
  const bundle = resolve(bundleRoot);
  const checks: { id: string; status: "PASS" | "BLOCKED"; detail: string }[] = [];
  const profile = readProfile(repo, checks);
  if (profile) {
    const configured = profile.bundleRoot.replaceAll("\\", "/");
    const expected = bundle.replaceAll("\\", "/");
    if (requireCurrentBundle) checks.push({ id: "bundle-path", status: configured === expected ? "PASS" : "BLOCKED", detail: configured === expected ? "Install profile points to the active bundle." : "Install profile points to a different bundle; run upgrade from the intended bundle." });
  }
  const config = validateConfig(repo);
  checks.push({ id: "managed-config", status: config.status === "PASS" ? "PASS" : "BLOCKED", detail: config.status === "PASS" ? "All installer-owned configuration validates." : "Installer-owned configuration is missing or invalid." });
  const missingRuntime = RUNTIME_PATHS.filter((path) => !existsSync(join(bundle, path)));
  checks.push({ id: "bundle-runtime", status: missingRuntime.length === 0 ? "PASS" : "BLOCKED", detail: missingRuntime.length === 0 ? "All root, module, control, and provenance runtime entries exist." : `Missing bundle entries: ${missingRuntime.join(", ")}` });
  return { status: checks.every((check) => check.status === "PASS") ? "PASS" : "BLOCKED", profile: profile?.profile ?? null, checks };
}

export function upgrade(repositoryRoot: string, bundleRoot: string): Record<string, unknown> {
  const repo = resolve(repositoryRoot);
  const bundle = resolve(bundleRoot);
  const check = checkInstall(repo, bundle, false);
  if (check.status !== "PASS") return { schemaVersion: "1.0", status: "BLOCKED", mode: "apply", check, message: "Upgrade is refused until install checks pass." };
  const profile = readProfile(repo, [])!;
  const upgradeId = `upgrade-${Date.now()}`;
  const backupRoot = join(repo, ".infoapex-ai", "backups", upgradeId);
  const journalPath = join(repo, ".infoapex-ai", "releases", `${upgradeId}.json`);
  const entries: JournalEntry[] = [];
  for (const path of UPGRADE_PATHS) {
    const source = join(repo, path);
    if (!existsSync(source)) {
      entries.push({ path, existed: false, sha256: null, backupSha256: null });
      continue;
    }
    const target = join(backupRoot, path);
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(source, target);
    const sourceHash = digestFile(source);
    const backupHash = digestFile(target);
    if (sourceHash !== backupHash) return { schemaVersion: "1.0", status: "BLOCKED", mode: "apply", upgradeId, message: `Backup verification failed for ${path}.` };
    entries.push({ path, existed: true, sha256: sourceHash, backupSha256: backupHash });
  }
  let journal: UpgradeJournal = { schemaVersion: "1.0", upgradeId, status: "PREPARED", createdAt: new Date().toISOString(), bundleRoot: bundle, previousBundleRoot: profile.bundleRoot, profile: profile.profile, layout: profile.layout, backupRoot, entries };
  writeJournal(journalPath, journal);
  try {
    const result = fullInstall({ repositoryRoot: repo, bundleRoot: bundle, profile: profile.profile, layout: profile.layout, repair: true });
    if (result.status !== "DONE") {
      journal = { ...journal, status: "FAILED", installResult: result };
      writeJournal(journalPath, journal);
      return { schemaVersion: "1.0", status: "BLOCKED", mode: "apply", upgradeId, journalPath, install: result };
    }
    journal = {
      ...journal,
      status: "APPLIED",
      appliedAt: new Date().toISOString(),
      entries: entries.map((entry) => ({ ...entry, postUpgradeSha256: existsSync(join(repo, entry.path)) ? digestFile(join(repo, entry.path)) : null })),
      installResult: result
    };
    writeJournal(journalPath, journal);
    return { schemaVersion: "1.0", status: "PASS", mode: "apply", upgradeId, journalPath, backupRoot, install: result };
  } catch (error) {
    journal = { ...journal, status: "FAILED", installResult: String(error) };
    writeJournal(journalPath, journal);
    return { schemaVersion: "1.0", status: "BLOCKED", mode: "apply", upgradeId, journalPath, message: "Upgrade failed; rollback remains available from the prepared journal." };
  }
}

export function rollbackRelease(repositoryRoot: string, upgradeId: string | null, dryRun: boolean): Record<string, unknown> {
  const repo = resolve(repositoryRoot);
  const journalPath = upgradeId ? join(repo, ".infoapex-ai", "releases", `${upgradeId}.json`) : latestJournal(repo);
  if (!journalPath || !existsSync(journalPath)) return { schemaVersion: "1.0", status: "BLOCKED", message: "No upgrade journal found; release rollback is refused." };
  let journal: UpgradeJournal;
  try { journal = JSON.parse(readFileSync(journalPath, "utf8")) as UpgradeJournal; } catch { return { schemaVersion: "1.0", status: "BLOCKED", message: "Upgrade journal is invalid." }; }
  if (journal.status !== "APPLIED" && journal.status !== "FAILED" && journal.status !== "PREPARED") return { schemaVersion: "1.0", status: "BLOCKED", upgradeId: journal.upgradeId, message: `Journal status ${journal.status} cannot be rolled back.` };
  const backupRoot = resolve(journal.backupRoot);
  if (!inside(repo, backupRoot)) return { schemaVersion: "1.0", status: "BLOCKED", upgradeId: journal.upgradeId, message: "Backup path is outside the repository." };
  for (const entry of journal.entries) {
    if (entry.path.includes("..") || entry.path.startsWith("/") || /^[a-zA-Z]:/.test(entry.path)) return { schemaVersion: "1.0", status: "BLOCKED", upgradeId: journal.upgradeId, message: "Upgrade journal contains an unsafe path." };
    if (entry.existed) {
      const backup = join(backupRoot, entry.path);
      if (!existsSync(backup) || digestFile(backup) !== entry.backupSha256) return { schemaVersion: "1.0", status: "BLOCKED", upgradeId: journal.upgradeId, message: `Backup verification failed for ${entry.path}.` };
    }
  }
  if (dryRun) return { schemaVersion: "1.0", status: "PASS", mode: "dry-run", upgradeId: journal.upgradeId, files: journal.entries.map((entry) => entry.path) };
  for (const entry of journal.entries) {
    const target = join(repo, entry.path);
    if (entry.existed) {
      mkdirSync(dirname(target), { recursive: true });
      copyFileSync(join(backupRoot, entry.path), target);
    } else if (existsSync(target)) {
      if (!entry.postUpgradeSha256 || digestFile(target) !== entry.postUpgradeSha256) return { schemaVersion: "1.0", status: "BLOCKED", upgradeId: journal.upgradeId, message: `Refusing to delete changed installer path ${entry.path}.` };
      rmSync(target, { force: true });
    }
  }
  writeJournal(journalPath, { ...journal, status: "ROLLED_BACK", rolledBackAt: new Date().toISOString() });
  return { schemaVersion: "1.0", status: "PASS", mode: "rollback", upgradeId: journal.upgradeId, restored: journal.entries.filter((entry) => entry.existed).length };
}

function readProfile(repo: string, checks: { id: string; status: "PASS" | "BLOCKED"; detail: string }[]): InstallProfileRecord | null {
  const path = join(repo, ".infoapex-ai", "install-profile.json");
  if (!existsSync(path)) { checks.push({ id: "install-profile", status: "BLOCKED", detail: "Full install profile is missing." }); return null; }
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    const layout = value.layout as Record<string, unknown> | undefined;
    const valid = value.schemaVersion === "1.0" && (value.profile === "generic" || value.profile === "dotnet-nextjs") && typeof value.bundleRoot === "string" && typeof layout?.backendDir === "string" && typeof layout?.frontendDir === "string" && (typeof layout.mlDir === "string" || layout.mlDir === null);
    checks.push({ id: "install-profile", status: valid ? "PASS" : "BLOCKED", detail: valid ? "Full install profile is valid." : "Full install profile is incomplete or unsupported." });
    return valid ? value as unknown as InstallProfileRecord : null;
  } catch { checks.push({ id: "install-profile", status: "BLOCKED", detail: "Full install profile is invalid JSON." }); return null; }
}

function latestJournal(repo: string): string | null {
  const root = join(repo, ".infoapex-ai", "releases");
  if (!existsSync(root)) return null;
  const names = readdirSync(root).filter((name) => name.endsWith(".json")).sort();
  return names.length > 0 ? join(root, names[names.length - 1]!) : null;
}

function writeJournal(path: string, journal: UpgradeJournal): void { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, `${JSON.stringify(journal, null, 2)}\n`, "utf8"); }
function digestFile(path: string): string { return createHash("sha256").update(readFileSync(path)).digest("hex"); }
function inside(root: string, target: string): boolean { const rel = relative(resolve(root), resolve(target)); return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)); }
