import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

const MANAGED = [
  ".infoapex-ai/config.json", ".infoapex-ai/install-profile.json", ".infoapex-ai/production-policy.json", ".ai-code-worker/config.json",
  ".ai-code-worker/routing-policy.json", ".ai-code-worker/execution-environment.example.json", ".ai-code-benchmark/config.json", ".ai-code-review/config.json", ".ai-code-docs/config.json",
  ".ai-code-control/config/code-control.json", ".ai-code-control/config/memory-control.json"
] as const;
const VERSIONED = new Set<string>(MANAGED.filter((path) => !path.includes("ai-code-control/config")));
const MIGRATION_ID = "config-v1";
const JOURNAL_RELATIVE_PATH = `.infoapex-ai/migrations/${MIGRATION_ID}.json`;
const SHA256 = /^[a-f0-9]{64}$/;

type Status = "PASS" | "BLOCKED";
type Check = { readonly path: string; readonly status: Status; readonly detail: string; readonly code?: string };
type JournalEntry = { readonly path: string; readonly sha256: string; readonly backupSha256: string; readonly targetSha256: string };
type MigrationJournal = { readonly schemaVersion: "1.0"; readonly migrationId: typeof MIGRATION_ID; readonly appliedAt: string; readonly backupRoot: string; readonly entries: readonly JournalEntry[] };

export interface LifecycleReport { readonly schemaVersion: "1.0"; readonly status: Status; readonly code: string; readonly checks: readonly Check[]; }

/** Validate only installer-owned JSON. Unknown fields are preserved; validation never rewrites. */
export function validateConfig(repositoryRoot: string): LifecycleReport {
  let repo: string;
  try { repo = repository(repositoryRoot); }
  catch (error) { return blockedValidation(diagnostic(error)); }

  const checks: Check[] = [];
  for (const file of MANAGED) {
    try {
      const path = containedPath(repo, file);
      if (!existsSync(path)) { checks.push({ path: file, status: "BLOCKED", code: "CONFIG_MISSING", detail: "Missing." }); continue; }
      const value = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
      const versionOk = !VERSIONED.has(file) || value.schemaVersion === "1.0";
      checks.push({ path: file, status: versionOk ? "PASS" : "BLOCKED", code: versionOk ? "CONFIG_VALID" : "CONFIG_SCHEMA_UNSUPPORTED", detail: versionOk ? "Valid JSON and supported schema." : "Unsupported schemaVersion." });
    } catch (error) {
      checks.push({ path: file, status: "BLOCKED", code: error instanceof PathBoundaryError ? "PATH_UNSAFE" : "CONFIG_INVALID", detail: error instanceof PathBoundaryError ? error.message : "Invalid JSON." });
    }
  }
  const install = checks.find((check) => check.path === ".infoapex-ai/install-profile.json");
  if (install?.status === "PASS") {
    try {
      const value = JSON.parse(readFileSync(containedPath(repo, install.path), "utf8")) as Record<string, unknown>;
      const valid = value.schemaVersion === "1.0" && (value.profile === "generic" || value.profile === "dotnet-nextjs") && typeof value.bundleRoot === "string";
      checks.push({ path: ".infoapex-ai/install-profile.json#contract", status: valid ? "PASS" : "BLOCKED", code: valid ? "CONFIG_CONTRACT_VALID" : "CONFIG_CONTRACT_UNSUPPORTED", detail: valid ? "Supported install-profile.v1." : "Unsupported or incomplete install profile." });
    } catch (error) {
      checks.push({ path: ".infoapex-ai/install-profile.json#contract", status: "BLOCKED", code: "PATH_UNSAFE", detail: diagnostic(error) });
    }
  }
  const passed = checks.every((check) => check.status === "PASS");
  return { schemaVersion: "1.0", status: passed ? "PASS" : "BLOCKED", code: passed ? "CONFIG_VALID" : "CONFIG_INVALID", checks };
}

/** Produces a redacted explanation: hashes and paths, never configuration values/secrets. */
export function explainConfig(repositoryRoot: string): Record<string, unknown> {
  const validation = validateConfig(repositoryRoot);
  let repo: string;
  try { repo = repository(repositoryRoot); }
  catch { return { schemaVersion: "1.0", status: "BLOCKED", code: "REPOSITORY_UNSAFE", repository: null, managedFiles: [], validation }; }
  return {
    schemaVersion: "1.0", status: validation.status, code: validation.code, repository: repo,
    managedFiles: MANAGED.map((file) => {
      try { const path = containedPath(repo, file); return { path: file, exists: existsSync(path), sha256: existsSync(path) ? digest(readFileSync(path)) : null }; }
      catch { return { path: file, exists: false, sha256: null }; }
    }), validation
  };
}

/** Check, simulate, or apply the v1 migration without trusting external paths or journals. */
export function migrate(repositoryRoot: string, mode: "check" | "dry-run" | "apply"): Record<string, unknown> {
  let repo: string;
  try { repo = repository(repositoryRoot); }
  catch (error) { return migrationBlocked(mode, "REPOSITORY_UNSAFE", diagnostic(error)); }
  const validation = validateConfig(repo);
  if (validation.status !== "PASS") return { schemaVersion: "1.0", status: "BLOCKED", code: "CONFIG_INVALID", mode, migrationId: MIGRATION_ID, validation, message: "Configuration must validate before migration." };

  let journalPath: string;
  try { journalPath = containedPath(repo, JOURNAL_RELATIVE_PATH); }
  catch (error) { return migrationBlocked(mode, "PATH_UNSAFE", diagnostic(error)); }
  if (existsSync(journalPath)) {
    const journal = readJournal(repo, journalPath);
    if ("error" in journal) return migrationBlocked(mode, journal.code, journal.error);
    return { schemaVersion: "1.0", status: "PASS", code: "MIGRATION_ALREADY_APPLIED", mode, migrationId: MIGRATION_ID, idempotent: true, journalPath: JOURNAL_RELATIVE_PATH, backupRoot: journal.value.backupRoot, message: "Migration already applied." };
  }

  const files = MANAGED.filter((file) => {
    try { return existsSync(containedPath(repo, file)); }
    catch { return false; }
  });
  if (mode !== "apply") return { schemaVersion: "1.0", status: "PASS", code: "MIGRATION_READY", mode, migrationId: MIGRATION_ID, files, wouldCreate: [".infoapex-ai/backups/<timestamp>", JOURNAL_RELATIVE_PATH] };

  const backupRoot = `.infoapex-ai/backups/${new Date().toISOString().replace(/[:.]/g, "-")}`;
  try {
    const entries: JournalEntry[] = files.map((file) => {
      const source = containedPath(repo, file);
      const backup = containedPath(repo, join(backupRoot, file));
      mkdirSync(dirname(backup), { recursive: true });
      copyFileSync(source, backup);
      const sourceHash = digest(readFileSync(source));
      const backupHash = digest(readFileSync(backup));
      if (sourceHash !== backupHash) throw new Error(`Backup verification failed for ${file}.`);
      return { path: file, sha256: sourceHash, backupSha256: backupHash, targetSha256: sourceHash };
    });
    mkdirSync(dirname(journalPath), { recursive: true });
    const journal: MigrationJournal = { schemaVersion: "1.0", migrationId: MIGRATION_ID, appliedAt: new Date().toISOString(), backupRoot, entries };
    writeFileSync(journalPath, `${JSON.stringify(journal, null, 2)}\n`, "utf8");
    const verifiedJournal = readJournal(repo, journalPath);
    if ("error" in verifiedJournal) return migrationBlocked(mode, verifiedJournal.code, verifiedJournal.error);
    return { schemaVersion: "1.0", status: "PASS", code: "MIGRATION_APPLIED", mode, migrationId: MIGRATION_ID, backupRoot, journalPath: JOURNAL_RELATIVE_PATH, entries: entries.length };
  } catch (error) {
    return migrationBlocked(mode, error instanceof PathBoundaryError ? "PATH_UNSAFE" : "BACKUP_VERIFICATION_FAILED", diagnostic(error));
  }
}

/** Restores exactly a verified, repository-contained migration backup; changed targets are refused. */
export function rollbackConfig(repositoryRoot: string, migrationId = MIGRATION_ID, dryRun = false): Record<string, unknown> {
  let repo: string;
  try { repo = repository(repositoryRoot); }
  catch (error) { return rollbackBlocked(migrationId, "REPOSITORY_UNSAFE", diagnostic(error)); }
  if (migrationId !== MIGRATION_ID) return rollbackBlocked(migrationId, "MIGRATION_ID_UNSUPPORTED", "Unsupported migration identifier.");
  let journalPath: string;
  try { journalPath = containedPath(repo, JOURNAL_RELATIVE_PATH); }
  catch (error) { return rollbackBlocked(migrationId, "PATH_UNSAFE", diagnostic(error)); }
  if (!existsSync(journalPath)) return rollbackBlocked(migrationId, "JOURNAL_NOT_FOUND", "Migration journal not found; rollback is refused.");
  const parsed = readJournal(repo, journalPath);
  if ("error" in parsed) return rollbackBlocked(migrationId, parsed.code, parsed.error);
  const journal = parsed.value;
  try {
    for (const entry of journal.entries) {
      const source = containedPath(repo, join(journal.backupRoot, entry.path));
      const target = containedPath(repo, entry.path);
      if (!existsSync(source) || digest(readFileSync(source)) !== entry.backupSha256) return rollbackBlocked(migrationId, "BACKUP_VERIFICATION_FAILED", `Backup verification failed for ${entry.path}.`);
      if (!existsSync(target) || digest(readFileSync(target)) !== entry.targetSha256) return rollbackBlocked(migrationId, "TARGET_CHANGED", `Target changed since migration for ${entry.path}; rollback is refused.`);
    }
    if (dryRun) return { schemaVersion: "1.0", status: "PASS", code: "ROLLBACK_READY", migrationId, mode: "dry-run", files: journal.entries.map((entry) => entry.path) };
    for (const entry of journal.entries) {
      const target = containedPath(repo, entry.path);
      mkdirSync(dirname(target), { recursive: true });
      copyFileSync(containedPath(repo, join(journal.backupRoot, entry.path)), target);
    }
    return { schemaVersion: "1.0", status: "PASS", code: "ROLLBACK_APPLIED", migrationId, restored: journal.entries.length };
  } catch (error) {
    return rollbackBlocked(migrationId, error instanceof PathBoundaryError ? "PATH_UNSAFE" : "BACKUP_VERIFICATION_FAILED", diagnostic(error));
  }
}

function readJournal(repo: string, journalPath: string): { readonly value: MigrationJournal } | { readonly code: string; readonly error: string } {
  try {
    const value = JSON.parse(readFileSync(journalPath, "utf8")) as unknown;
    if (!isJournal(value)) return { code: "JOURNAL_INVALID", error: "Migration journal is malformed or unsupported." };
    containedPath(repo, value.backupRoot);
    if (!value.backupRoot.startsWith(".infoapex-ai/backups/")) return { code: "JOURNAL_INVALID", error: "Migration journal backup root is outside the supported backup location." };
    for (const entry of value.entries) {
      if (!MANAGED.includes(entry.path as typeof MANAGED[number])) return { code: "JOURNAL_INVALID", error: "Migration journal contains an unmanaged path." };
      containedPath(repo, entry.path);
      containedPath(repo, join(value.backupRoot, entry.path));
    }
    return { value };
  } catch (error) {
    return { code: error instanceof PathBoundaryError ? "PATH_UNSAFE" : "JOURNAL_INVALID", error: error instanceof PathBoundaryError ? error.message : "Migration journal is invalid." };
  }
}

function isJournal(value: unknown): value is MigrationJournal {
  if (!value || typeof value !== "object") return false;
  const journal = value as Record<string, unknown>;
  if (journal.schemaVersion !== "1.0" || journal.migrationId !== MIGRATION_ID || typeof journal.appliedAt !== "string" || Number.isNaN(Date.parse(journal.appliedAt)) || typeof journal.backupRoot !== "string" || !isSafeRelative(journal.backupRoot) || !Array.isArray(journal.entries) || journal.entries.length !== MANAGED.length || !journal.entries.every(isJournalEntry)) return false;
  const paths = journal.entries.map((entry) => entry.path);
  return new Set(paths).size === MANAGED.length && MANAGED.every((path) => paths.includes(path));
}

function isJournalEntry(value: unknown): value is JournalEntry {
  if (!value || typeof value !== "object") return false;
  const entry = value as Record<string, unknown>;
  return typeof entry.path === "string" && isSafeRelative(entry.path) && typeof entry.sha256 === "string" && SHA256.test(entry.sha256) && typeof entry.backupSha256 === "string" && SHA256.test(entry.backupSha256) && typeof entry.targetSha256 === "string" && SHA256.test(entry.targetSha256);
}

function repository(repositoryRoot: string): string {
  if (typeof repositoryRoot !== "string" || repositoryRoot.length === 0) throw new PathBoundaryError("Repository path is invalid.");
  const repo = realpathSync(resolve(repositoryRoot));
  if (lstatSync(repo).isSymbolicLink()) throw new PathBoundaryError("Repository root must not be a symbolic link.");
  return repo;
}

/** Resolves an approved relative path and rejects lexical and symlink escapes before I/O. */
function containedPath(repo: string, file: string): string {
  if (!isSafeRelative(file)) throw new PathBoundaryError("Unsafe repository-relative path.");
  const target = resolve(repo, file);
  const fromRepo = relative(repo, target);
  if (fromRepo === "" || fromRepo === ".." || fromRepo.startsWith(`..${sep}`) || isAbsolute(fromRepo)) throw new PathBoundaryError("Path escapes the repository.");
  let current = repo;
  for (const segment of file.split(/[\\/]/u)) {
    current = join(current, segment);
    if (existsSync(current) && lstatSync(current).isSymbolicLink()) throw new PathBoundaryError("Symbolic links are not permitted in configuration lifecycle paths.");
  }
  return target;
}

function isSafeRelative(value: string): boolean {
  return value.length > 0 && !isAbsolute(value) && !/^[a-zA-Z]:/.test(value) && value.split(/[\\/]/u).every((segment) => segment.length > 0 && segment !== "." && segment !== "..");
}

class PathBoundaryError extends Error {}
function digest(value: string | Buffer): string { return createHash("sha256").update(value).digest("hex"); }
function diagnostic(error: unknown): string { return error instanceof Error && error.message.length > 0 ? error.message : "Configuration lifecycle operation was refused."; }
function blockedValidation(detail: string): LifecycleReport { return { schemaVersion: "1.0", status: "BLOCKED", code: "REPOSITORY_UNSAFE", checks: [{ path: "repository", status: "BLOCKED", code: "REPOSITORY_UNSAFE", detail }] }; }
function migrationBlocked(mode: string, code: string, message: string): Record<string, unknown> { return { schemaVersion: "1.0", status: "BLOCKED", code, mode, migrationId: MIGRATION_ID, message }; }
function rollbackBlocked(migrationId: string, code: string, message: string): Record<string, unknown> { return { schemaVersion: "1.0", status: "BLOCKED", code, migrationId, message }; }
