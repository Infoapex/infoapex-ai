import { accessSync, constants, copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fullInstall, type InstallProfile, verifyFilesystemPermissions } from "./full-install.js";
import { validateConfig } from "./config-lifecycle.js";

const RUNTIME_PATHS = ["dist/src/cli.js", "modules/ai-code-planner/dist/src/cli.js", "modules/ai-code-worker/dist/src/cli.js", "modules/ai-code-review/dist/src/cli.js", "modules/ai-code-docs/dist/src/cli.js", "modules/ai-code-benchmark/dist/src/cli.js", "modules/ai-code-control/tools/ai-code-control/mcp-server/dist/server.js", "modules/ai-code-control/tools/ai-code-control/src/AiCodeControl.Cli/AiCodeControl.Cli.csproj", "modules/provenance.json"] as const;
const UPGRADE_PATHS = [".ai-code-control/config/code-control.json", ".ai-code-control/config/memory-control.json", ".ai-code-control/reports/refactor/current-plan.json", ".ai-code-worker/config.json", ".ai-code-worker/routing-policy.json", ".ai-code-worker/execution-environment.example.json", ".ai-code-benchmark/config.json", ".ai-code-review/config.json", ".ai-code-docs/config.json", ".mcp.json", ".claude/settings.json", ".codex/config.toml", ".infoapex-ai/install-profile.json", ".infoapex-ai/production-policy.json", ".gitignore"] as const;
const SHA256 = /^[a-f0-9]{64}$/;
const UPGRADE_ID = /^upgrade-\d{13}-[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
type Status = "PASS" | "BLOCKED";

export interface LifecycleCheck { readonly status: Status; readonly profile: InstallProfile | null; readonly checks: readonly { readonly id: string; readonly status: Status; readonly detail: string }[]; }
interface InstallProfileRecord { readonly schemaVersion: "1.0"; readonly profile: InstallProfile; readonly bundleRoot: string; readonly layout: { readonly backendDir: string; readonly frontendDir: string; readonly mlDir: string | null }; }
interface JournalEntry { readonly path: string; readonly existed: boolean; readonly sha256: string | null; readonly backupSha256: string | null; readonly postUpgradeSha256?: string | null; }
interface UpgradeJournal { readonly schemaVersion: "1.0"; readonly upgradeId: string; readonly status: "PREPARED" | "APPLIED" | "FAILED" | "ROLLED_BACK"; readonly createdAt: string; readonly appliedAt?: string; readonly rolledBackAt?: string; readonly bundleRoot: string; readonly previousBundleRoot: string; readonly profile: InstallProfile; readonly layout: InstallProfileRecord["layout"]; readonly backupRoot: string; readonly entries: readonly JournalEntry[]; readonly installResult?: unknown; }

/** Read-only release check. Roots and every derived path are validated before use. */
export function checkInstall(repositoryRoot: string, bundleRoot: string, requireCurrentBundle = true): LifecycleCheck {
  const roots = checkedRoots(repositoryRoot, bundleRoot);
  if ("error" in roots) return blockedCheck(roots.error);
  const checks: { id: string; status: Status; detail: string }[] = [];
  const gitReady = hasCommittedGitHead(roots.repo);
  const writable = isWritableDirectory(roots.repo);
  checks.push({ id: "git-repository", status: gitReady ? "PASS" : "BLOCKED", detail: gitReady ? "Repository has a committed Git HEAD." : "Repository must have a Git repository with an initial commit." });
  checks.push({ id: "repository-write-access", status: writable ? "PASS" : "BLOCKED", detail: writable ? "Current user can write installer-managed files." : "Current user cannot write installer-managed files in the repository." });
  const profile = readProfile(roots.repo, checks);
  if (profile && requireCurrentBundle) {
    const matches = normalizePath(profile.bundleRoot) === normalizePath(roots.bundle);
    checks.push({ id: "bundle-path", status: matches ? "PASS" : "BLOCKED", detail: matches ? "Install profile points to the active bundle." : "Install profile points to a different bundle; run upgrade from the intended bundle." });
  }
  const config = validateConfig(roots.repo);
  checks.push({ id: "managed-config", status: config.status === "PASS" ? "PASS" : "BLOCKED", detail: config.status === "PASS" ? "All installer-owned configuration validates." : "Installer-owned configuration is missing or invalid." });
  const workerConfig = safeReadJson(roots.repo, ".ai-code-worker/config.json");
  const providerPolicy = workerConfig?.contextProvider === "ai-code-control" && workerConfig?.contextPackage?.mode === "observe" &&
    workerConfig?.adapters?.codex?.model === "gpt-5.6" && workerConfig?.adapters?.codex?.reasoningEffort === "high" &&
    Array.isArray(workerConfig?.adapters?.aiCodeControl?.baseArgs);
  checks.push({ id: "explicit-provider-policy", status: providerPolicy ? "PASS" : "BLOCKED", detail: providerPolicy ? "Codex gpt-5.6/high is explicit; no automatic engine fallback is configured." : "Worker context/provider policy is incomplete or stale; rerun full init with --repair after review." });
  checks.push(...verifyFilesystemPermissions(roots.repo, roots.bundle).checks);
  const missing = RUNTIME_PATHS.filter((path) => !safeExists(roots.bundle, path));
  checks.push({ id: "bundle-runtime", status: missing.length === 0 ? "PASS" : "BLOCKED", detail: missing.length === 0 ? "All root, module, control, and provenance runtime entries exist." : `Missing or unsafe bundle entries: ${missing.join(", ")}` });
  return { status: checks.every((check) => check.status === "PASS") ? "PASS" : "BLOCKED", profile: profile?.profile ?? null, checks };
}

export function upgrade(repositoryRoot: string, bundleRoot: string): Record<string, unknown> {
  const roots = checkedRoots(repositoryRoot, bundleRoot);
  if ("error" in roots) return blocked("apply", "REPOSITORY_OR_BUNDLE_UNSAFE", roots.error);
  const check = checkInstall(roots.repo, roots.bundle, false);
  if (check.status !== "PASS") return { schemaVersion: "1.0", status: "BLOCKED", code: "INSTALL_CHECK_FAILED", mode: "apply", check, message: "Upgrade is refused until install checks pass." };
  const profile = readProfile(roots.repo, []);
  if (!profile) return blocked("apply", "PROFILE_INVALID", "Install profile is invalid.");
  const upgradeId = `upgrade-${Date.now()}-${randomUUID()}`;
  const backupRoot = repoPath(roots.repo, `.infoapex-ai/backups/${upgradeId}`);
  const journalPath = repoPath(roots.repo, `.infoapex-ai/releases/${upgradeId}.json`);
  if (!backupRoot || !journalPath) return blocked("apply", "PATH_UNSAFE", "Release paths are outside the repository.");
  const entries: JournalEntry[] = [];
  for (const path of UPGRADE_PATHS) {
    const source = repoPath(roots.repo, path); const target = repoPath(backupRoot, path);
    if (!source || !target) return blocked("apply", "PATH_UNSAFE", `Unsafe managed path ${path}.`);
    if (!existsSync(source)) { entries.push({ path, existed: false, sha256: null, backupSha256: null }); continue; }
    mkdirSync(dirname(target), { recursive: true }); copyFileSync(source, target);
    const sourceHash = digestFile(source); const backupHash = digestFile(target);
    if (sourceHash !== backupHash) return blocked("apply", "BACKUP_INVALID", `Backup verification failed for ${path}.`);
    entries.push({ path, existed: true, sha256: sourceHash, backupSha256: backupHash });
  }
  let journal: UpgradeJournal = { schemaVersion: "1.0", upgradeId, status: "PREPARED", createdAt: new Date().toISOString(), bundleRoot: normalizePath(roots.bundle), previousBundleRoot: normalizePath(profile.bundleRoot), profile: profile.profile, layout: profile.layout, backupRoot: normalizePath(backupRoot), entries };
  writeJournal(journalPath, journal);
  try {
    // Preserve an operator-provisioned Docker/provider profile across upgrades.
    // Replacing it with the installer's simulation default would silently widen
    // or change the execution contract of an already configured consumer.
    const executionProfilePath = repoPath(roots.repo, ".ai-code-worker/execution-environment.example.json") ?? undefined;
    const result = fullInstall({ repositoryRoot: roots.repo, bundleRoot: roots.bundle, profile: profile.profile, layout: profile.layout, repair: true, executionProfilePath });
    journal = { ...journal, status: result.status === "DONE" ? "APPLIED" : "FAILED", ...(result.status === "DONE" ? { appliedAt: new Date().toISOString() } : {}), entries: withTargetHashes(roots.repo, entries), installResult: result };
    writeJournal(journalPath, journal);
    return result.status === "DONE" ? { schemaVersion: "1.0", status: "PASS", code: "UPGRADE_APPLIED", mode: "apply", upgradeId, journalPath, backupRoot, install: result } : { schemaVersion: "1.0", status: "BLOCKED", code: "INSTALL_FAILED", mode: "apply", upgradeId, journalPath, install: result };
  } catch (error) {
    journal = { ...journal, status: "FAILED", entries: withTargetHashes(roots.repo, entries), installResult: String(error) }; writeJournal(journalPath, journal);
    return { schemaVersion: "1.0", status: "BLOCKED", code: "UPGRADE_FAILED", mode: "apply", upgradeId, journalPath, message: "Upgrade failed; rollback remains available from the verified journal." };
  }
}

export function rollbackRelease(repositoryRoot: string, upgradeId: string | null, dryRun: boolean): Record<string, unknown> {
  const root = checkedRepository(repositoryRoot); const mode = dryRun ? "dry-run" : "rollback";
  if ("error" in root) return blocked(mode, "REPOSITORY_UNSAFE", root.error);
  if (upgradeId !== null && !UPGRADE_ID.test(upgradeId)) return blocked(mode, "UPGRADE_ID_INVALID", "Upgrade identifier is invalid.");
  const journalPath = upgradeId ? repoPath(root.repo, `.infoapex-ai/releases/${upgradeId}.json`) : latestJournal(root.repo);
  if (!journalPath || !existsSync(journalPath)) return blocked(mode, "JOURNAL_MISSING", "No upgrade journal found; release rollback is refused.");
  let journal: UpgradeJournal;
  try { journal = JSON.parse(readFileSync(journalPath, "utf8")) as UpgradeJournal; } catch { return blocked(mode, "JOURNAL_INVALID", "Upgrade journal is invalid JSON."); }
  const invalid = validateJournal(root.repo, journal);
  if (invalid) return blocked(mode, "JOURNAL_INVALID", invalid, journal.upgradeId);
  if (journal.status === "ROLLED_BACK") return { schemaVersion: "1.0", status: "PASS", code: "ROLLBACK_ALREADY_APPLIED", mode, upgradeId: journal.upgradeId, files: journal.entries.map((entry) => entry.path) };
  // Validate every backup and every live target before the first restore write.
  for (const entry of journal.entries) {
    const backup = repoPath(journal.backupRoot, entry.path); const target = repoPath(root.repo, entry.path);
    if (!backup || !target) return blocked(mode, "PATH_UNSAFE", "Journal path escapes its intended root.", journal.upgradeId);
    if (entry.existed && (!existsSync(backup) || digestFile(backup) !== entry.backupSha256)) return blocked(mode, "BACKUP_INVALID", `Backup verification failed for ${entry.path}.`, journal.upgradeId);
    const expected = entry.postUpgradeSha256 ?? entry.sha256;
    if (expected === null) { if (existsSync(target)) return blocked(mode, "TARGET_CHANGED", `Refusing to delete changed installer path ${entry.path}.`, journal.upgradeId); }
    else if (!existsSync(target) || digestFile(target) !== expected) return blocked(mode, "TARGET_CHANGED", `Refusing to restore over changed installer path ${entry.path}.`, journal.upgradeId);
  }
  if (dryRun) return { schemaVersion: "1.0", status: "PASS", code: "ROLLBACK_READY", mode, upgradeId: journal.upgradeId, files: journal.entries.map((entry) => entry.path) };
  for (const entry of journal.entries) {
    const target = repoPath(root.repo, entry.path)!;
    if (entry.existed) { mkdirSync(dirname(target), { recursive: true }); copyFileSync(repoPath(journal.backupRoot, entry.path)!, target); }
    else if (existsSync(target)) rmSync(target, { force: true });
  }
  writeJournal(journalPath, { ...journal, status: "ROLLED_BACK", rolledBackAt: new Date().toISOString() });
  return { schemaVersion: "1.0", status: "PASS", code: "ROLLBACK_APPLIED", mode, upgradeId: journal.upgradeId, restored: journal.entries.filter((entry) => entry.existed).length };
}

function readProfile(repo: string, checks: { id: string; status: Status; detail: string }[]): InstallProfileRecord | null {
  const path = repoPath(repo, ".infoapex-ai/install-profile.json");
  if (!path || !existsSync(path)) { checks.push({ id: "install-profile", status: "BLOCKED", detail: "Full install profile is missing or unsafe." }); return null; }
  try { const profile = profileRecord(JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>); checks.push({ id: "install-profile", status: profile ? "PASS" : "BLOCKED", detail: profile ? "Full install profile is valid." : "Full install profile is incomplete, unsafe, or unsupported." }); return profile; }
  catch { checks.push({ id: "install-profile", status: "BLOCKED", detail: "Full install profile is invalid JSON." }); return null; }
}
function profileRecord(value: Record<string, unknown>): InstallProfileRecord | null {
  const layout = value.layout as Record<string, unknown> | undefined; const profile = value.profile; const bundleRoot = value.bundleRoot;
  const valid = value.schemaVersion === "1.0" && (profile === "generic" || profile === "dotnet-nextjs") && typeof bundleRoot === "string" && validAbsolutePath(bundleRoot) && typeof layout?.backendDir === "string" && safeRelativePath(layout.backendDir) && typeof layout?.frontendDir === "string" && safeRelativePath(layout.frontendDir) && (layout.mlDir === null || (typeof layout.mlDir === "string" && safeRelativePath(layout.mlDir)));
  return valid ? value as unknown as InstallProfileRecord : null;
}
function validateJournal(repo: string, journal: UpgradeJournal): string | null {
  if (!journal || typeof journal !== "object" || journal.schemaVersion !== "1.0" || !UPGRADE_ID.test(journal.upgradeId)) return "Journal schemaVersion or upgrade identifier is invalid.";
  if (!(["PREPARED", "APPLIED", "FAILED", "ROLLED_BACK"] as const).includes(journal.status) || !validDate(journal.createdAt)) return "Journal status or creation timestamp is invalid.";
  if ((journal.status === "APPLIED" || journal.status === "ROLLED_BACK") && !validDate(journal.appliedAt)) return "Applied journal is missing its application timestamp.";
  if (journal.status === "ROLLED_BACK" && !validDate(journal.rolledBackAt)) return "Rolled-back journal is missing its rollback timestamp.";
  if (!validAbsolutePath(journal.bundleRoot) || !validAbsolutePath(journal.previousBundleRoot) || normalizePath(journal.backupRoot) !== normalizePath(join(repo, ".infoapex-ai", "backups", journal.upgradeId))) return "Journal bundle or backup root is invalid.";
  if (!profileRecord({ schemaVersion: "1.0", profile: journal.profile, bundleRoot: journal.previousBundleRoot, layout: journal.layout })) return "Journal profile or layout is invalid.";
  if (!Array.isArray(journal.entries) || journal.entries.length !== UPGRADE_PATHS.length || new Set(journal.entries.map((entry) => entry?.path)).size !== UPGRADE_PATHS.length) return "Journal entries are incomplete or duplicated.";
  for (const path of UPGRADE_PATHS) { const entry = journal.entries.find((candidate) => candidate?.path === path); if (!entry || !validEntry(entry, journal.status)) return `Journal entry for ${path} is invalid.`; }
  return null;
}
function validEntry(entry: JournalEntry, status: UpgradeJournal["status"]): boolean {
  if (!UPGRADE_PATHS.includes(entry.path as typeof UPGRADE_PATHS[number]) || typeof entry.existed !== "boolean") return false;
  if (entry.existed !== (typeof entry.sha256 === "string" && SHA256.test(entry.sha256) && typeof entry.backupSha256 === "string" && SHA256.test(entry.backupSha256) && entry.sha256 === entry.backupSha256)) return false;
  if (!entry.existed && (entry.sha256 !== null || entry.backupSha256 !== null)) return false;
  if (entry.postUpgradeSha256 !== undefined && entry.postUpgradeSha256 !== null && (typeof entry.postUpgradeSha256 !== "string" || !SHA256.test(entry.postUpgradeSha256))) return false;
  return status === "PREPARED" || entry.postUpgradeSha256 !== undefined;
}
function withTargetHashes(repo: string, entries: readonly JournalEntry[]): JournalEntry[] { return entries.map((entry) => { const target = repoPath(repo, entry.path); return { ...entry, postUpgradeSha256: target && existsSync(target) ? digestFile(target) : null }; }); }
function latestJournal(repo: string): string | null { const root = repoPath(repo, ".infoapex-ai/releases"); if (!root || !existsSync(root)) return null; const names = readdirSync(root).filter((name) => name.endsWith(".json") && UPGRADE_ID.test(name.slice(0, -5))).sort(); return names.length > 0 ? repoPath(repo, `.infoapex-ai/releases/${names[names.length - 1]!}`) : null; }
function checkedRoots(repositoryRoot: string, bundleRoot: string): { repo: string; bundle: string } | { error: string } { const repository = checkedRepository(repositoryRoot); if ("error" in repository) return repository; const bundle = checkedDirectory(bundleRoot, "Bundle"); return "error" in bundle ? bundle : { repo: repository.repo, bundle: bundle.path }; }
function checkedRepository(value: string): { repo: string } | { error: string } { const root = checkedDirectory(value, "Repository"); return "error" in root ? root : { repo: root.path }; }
function checkedDirectory(value: string, label: string): { path: string } | { error: string } { if (typeof value !== "string" || value.includes("\0")) return { error: `${label} path is invalid.` }; const path = resolve(value); try { const stat = lstatSync(path); if (!stat.isDirectory() || stat.isSymbolicLink()) return { error: `${label} root must be a real directory.` }; } catch { return { error: `${label} root does not exist or cannot be inspected.` }; } return { path }; }
function repoPath(root: string, path: string): string | null { return safePath(root, path); }
function safeExists(root: string, path: string): boolean { const candidate = safePath(root, path); return candidate !== null && existsSync(candidate); }
function safePath(root: string, path: string): string | null { if (!safeRelativePath(path)) return null; const candidate = resolve(root, path); if (!inside(root, candidate)) return null; let current = root; for (const part of path.split("/")) { current = join(current, part); if (!existsSync(current)) continue; try { if (lstatSync(current).isSymbolicLink()) return null; } catch { return null; } } return candidate; }
function safeRelativePath(value: string): boolean { return typeof value === "string" && value.length > 0 && !value.includes("\0") && !isAbsolute(value) && !value.includes("\\") && !value.split("/").some((part) => part === "" || part === "." || part === ".."); }
function validAbsolutePath(value: string): boolean { return typeof value === "string" && value.length > 0 && !value.includes("\0") && isAbsolute(value) && normalizePath(value) === normalizePath(resolve(value)); }
function validDate(value: unknown): boolean { return typeof value === "string" && Number.isFinite(Date.parse(value)); }
function normalizePath(path: string): string { return resolve(path).replaceAll("\\", "/"); }
function writeJournal(path: string, journal: UpgradeJournal): void { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, `${JSON.stringify(journal, null, 2)}\n`, "utf8"); }
function digestFile(path: string): string { return createHash("sha256").update(readFileSync(path)).digest("hex"); }
function inside(root: string, target: string): boolean { const rel = relative(resolve(root), resolve(target)); return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)); }
function blockedCheck(detail: string): LifecycleCheck { return { status: "BLOCKED", profile: null, checks: [{ id: "root-path", status: "BLOCKED", detail }] }; }
function blocked(mode: string, code: string, message: string, upgradeId?: string): Record<string, unknown> { return { schemaVersion: "1.0", status: "BLOCKED", code, mode, ...(upgradeId ? { upgradeId } : {}), message }; }

function hasCommittedGitHead(path: string): boolean { const result = spawnSync("git", ["-C", path, "rev-parse", "--verify", "HEAD"], { encoding: "utf8", windowsHide: true }); return result.status === 0; }
function isWritableDirectory(path: string): boolean { try { accessSync(path, constants.W_OK); return true; } catch { return false; } }
function safeReadJson(root: string, path: string): Record<string, any> | null { const candidate = safePath(root, path); if (!candidate || !existsSync(candidate)) return null; try { return JSON.parse(readFileSync(candidate, "utf8")) as Record<string, any>; } catch { return null; } }
