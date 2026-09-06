import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join, resolve } from "node:path";

const MANAGED = [
  ".infoapex-ai/config.json", ".infoapex-ai/install-profile.json", ".infoapex-ai/production-policy.json", ".ai-code-worker/config.json",
  ".ai-code-worker/routing-policy.json", ".ai-code-review/config.json", ".ai-code-docs/config.json",
  ".ai-code-control/config/code-control.json", ".ai-code-control/config/memory-control.json"
] as const;
const VERSIONED = new Set<string>(MANAGED.filter((path) => !path.includes("ai-code-control/config")));

export interface LifecycleReport { readonly status: "PASS" | "BLOCKED"; readonly checks: readonly { readonly path: string; readonly status: "PASS" | "BLOCKED"; readonly detail: string }[]; }

/** P6.1: validate only known, installer-owned JSON. Unknown fields are preserved; validation never rewrites. */
export function validateConfig(repositoryRoot: string): LifecycleReport {
  const repo = resolve(repositoryRoot); const checks: { path: string; status: "PASS" | "BLOCKED"; detail: string }[] = [];
  for (const relative of MANAGED) {
    const path = join(repo, relative);
    if (!existsSync(path)) { checks.push({ path: relative, status: "BLOCKED", detail: "Missing." }); continue; }
    try { const value = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>; const versionOk = !VERSIONED.has(relative) || value.schemaVersion === "1.0"; checks.push({ path: relative, status: versionOk ? "PASS" : "BLOCKED", detail: versionOk ? "Valid JSON and supported schema." : `Unsupported schemaVersion ${String(value.schemaVersion)}.` }); }
    catch { checks.push({ path: relative, status: "BLOCKED", detail: "Invalid JSON." }); }
  }
  const install = checks.find((check) => check.path === ".infoapex-ai/install-profile.json");
  if (install?.status === "PASS") {
    const value = JSON.parse(readFileSync(join(repo, install.path), "utf8")) as Record<string, unknown>;
    const valid = value.schemaVersion === "1.0" && (value.profile === "generic" || value.profile === "dotnet-nextjs") && typeof value.bundleRoot === "string";
    checks.push({ path: ".infoapex-ai/install-profile.json#contract", status: valid ? "PASS" : "BLOCKED", detail: valid ? "Supported install-profile.v1." : "Unsupported or incomplete install profile." });
  }
  return { status: checks.every((check) => check.status === "PASS") ? "PASS" : "BLOCKED", checks };
}

/** Produces a redacted explanation: hashes and paths, never configuration values/secrets. */
export function explainConfig(repositoryRoot: string): Record<string, unknown> {
  const repo = resolve(repositoryRoot); const validation = validateConfig(repo);
  return { schemaVersion: "1.0", status: validation.status, repository: repo, managedFiles: MANAGED.map((relative) => {
    const path = join(repo, relative); return { path: relative, exists: existsSync(path), sha256: existsSync(path) ? digest(readFileSync(path)) : null };
  }), validation };
}

/** Idempotent migration framework v1: validates first, then makes a verified backup before writing its journal. */
export function migrate(repositoryRoot: string, mode: "check" | "dry-run" | "apply"): Record<string, unknown> {
  const repo = resolve(repositoryRoot); const validation = validateConfig(repo);
  const migrationId = "config-v1";
  const journalPath = join(repo, ".infoapex-ai", "migrations", `${migrationId}.json`);
  if (validation.status !== "PASS") return { schemaVersion: "1.0", status: "BLOCKED", mode, migrationId, validation, message: "Configuration must validate before migration." };
  if (existsSync(journalPath)) return { schemaVersion: "1.0", status: "PASS", mode, migrationId, idempotent: true, journalPath, message: "Migration already applied." };
  const files = MANAGED.filter((relative) => existsSync(join(repo, relative)));
  if (mode !== "apply") return { schemaVersion: "1.0", status: "PASS", mode, migrationId, files, wouldCreate: [".infoapex-ai/backups/<timestamp>", ".infoapex-ai/migrations/config-v1.json"] };
  const backupRoot = join(repo, ".infoapex-ai", "backups", new Date().toISOString().replace(/[:.]/g, "-"));
  const entries = files.map((relative) => { const source = join(repo, relative); const target = join(backupRoot, relative); mkdirSync(dirname(target), { recursive: true }); copyFileSync(source, target); return { path: relative, sha256: digest(readFileSync(source)), backupSha256: digest(readFileSync(target)) }; });
  const verified = entries.every((entry) => entry.sha256 === entry.backupSha256);
  if (!verified) return { schemaVersion: "1.0", status: "BLOCKED", mode, migrationId, message: "Backup verification failed; no migration journal written." };
  mkdirSync(join(repo, ".infoapex-ai", "migrations"), { recursive: true });
  writeFileSync(journalPath, `${JSON.stringify({ schemaVersion: "1.0", migrationId, appliedAt: new Date().toISOString(), backupRoot, entries }, null, 2)}\n`, "utf8");
  return { schemaVersion: "1.0", status: "PASS", mode, migrationId, backupRoot, journalPath, entries: entries.length };
}

/** Restores exactly the files recorded in a verified migration journal. */
export function rollbackConfig(repositoryRoot: string, migrationId = "config-v1", dryRun = false): Record<string, unknown> {
  const repo = resolve(repositoryRoot); const journalPath = join(repo, ".infoapex-ai", "migrations", `${migrationId}.json`);
  if (!existsSync(journalPath)) return { schemaVersion: "1.0", status: "BLOCKED", migrationId, message: "Migration journal not found; rollback is refused." };
  let journal: { backupRoot?: unknown; entries?: unknown };
  try { journal = JSON.parse(readFileSync(journalPath, "utf8")) as typeof journal; } catch { return { schemaVersion: "1.0", status: "BLOCKED", migrationId, message: "Migration journal is invalid." }; }
  if (typeof journal.backupRoot !== "string" || !Array.isArray(journal.entries)) return { schemaVersion: "1.0", status: "BLOCKED", migrationId, message: "Migration journal has no valid backup inventory." };
  const invalid = journal.entries.some((entry) => !entry || typeof entry !== "object" || typeof (entry as Record<string, unknown>).path !== "string" || typeof (entry as Record<string, unknown>).backupSha256 !== "string");
  if (invalid) return { schemaVersion: "1.0", status: "BLOCKED", migrationId, message: "Migration journal contains an invalid entry." };
  const entries = journal.entries as { path: string; backupSha256: string }[];
  for (const entry of entries) {
    if (entry.path.includes("..") || entry.path.startsWith("/") || /^[a-zA-Z]:/.test(entry.path)) return { schemaVersion: "1.0", status: "BLOCKED", migrationId, message: "Migration journal contains an unsafe path." };
    const source = join(journal.backupRoot, entry.path);
    if (!existsSync(source) || digest(readFileSync(source)) !== entry.backupSha256) return { schemaVersion: "1.0", status: "BLOCKED", migrationId, message: `Backup verification failed for ${entry.path}.` };
  }
  if (dryRun) return { schemaVersion: "1.0", status: "PASS", migrationId, mode: "dry-run", files: entries.map((entry) => entry.path) };
  for (const entry of entries) { const target = join(repo, entry.path); mkdirSync(dirname(target), { recursive: true }); copyFileSync(join(journal.backupRoot, entry.path), target); }
  return { schemaVersion: "1.0", status: "PASS", migrationId, restored: entries.length };
}

function digest(value: string | Buffer): string { return createHash("sha256").update(value).digest("hex"); }
