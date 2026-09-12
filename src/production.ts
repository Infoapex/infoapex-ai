import { createHash, randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { explainConfig } from "./config-lifecycle.js";

export interface ProductionPolicy {
  readonly schemaVersion: "1.0";
  readonly profile: "core-local";
  readonly externalActions: "disabled";
  readonly telemetryExport: "off";
  readonly rawConversationStorage: false;
  readonly retentionDays: number;
  readonly resources: { readonly maximumRunMinutes: number; readonly maximumOutputBytes: number; readonly maximumParallelWriters: number; readonly staleLeaseMinutes: number };
}

export function defaultProductionPolicy(): ProductionPolicy { return { schemaVersion: "1.0", profile: "core-local", externalActions: "disabled", telemetryExport: "off", rawConversationStorage: false, retentionDays: 30, resources: { maximumRunMinutes: 30, maximumOutputBytes: 2_000_000, maximumParallelWriters: 1, staleLeaseMinutes: 60 } }; }

export function productionDoctor(repositoryRoot: string): Record<string, unknown> {
  const repo = resolve(repositoryRoot); const path = join(repo, ".infoapex-ai", "production-policy.json"); const findings: string[] = [];
  let policy: ProductionPolicy | null = null;
  try { policy = JSON.parse(readFileSync(path, "utf8")) as ProductionPolicy; } catch { findings.push("Missing or invalid production-policy.json."); }
  if (policy && (policy.profile !== "core-local" || policy.externalActions !== "disabled" || policy.telemetryExport !== "off" || policy.rawConversationStorage !== false)) findings.push("Production defaults must remain local, export-off, and raw-conversation-off.");
  if (policy && (policy.retentionDays < 1 || policy.resources.maximumParallelWriters !== 1 || policy.resources.maximumRunMinutes < 1)) findings.push("Production resource/retention bounds are invalid.");
  const lease = join(repo, ".infoapex-ai", "runtime", "lease.json");
  if (existsSync(lease) && policy) { const age = Date.now() - statSync(lease).mtimeMs; if (age > policy.resources.staleLeaseMinutes * 60_000) findings.push("A stale runtime lease requires explicit recovery."); else findings.push("An active runtime lease already exists."); }
  return { schemaVersion: "1.0", status: findings.length === 0 ? "PASS" : "BLOCKED", policyPath: path, findings };
}

export function acquireLease(repositoryRoot: string, runId: string): Record<string, unknown> {
  const repo = resolve(repositoryRoot); const doctor = productionDoctor(repo); if (doctor.status !== "PASS") return doctor;
  const path = join(repo, ".infoapex-ai", "runtime", "lease.json"); mkdirSync(dirname(path), { recursive: true });
  const body = { schemaVersion: "1.0", leaseId: randomUUID(), runId, processId: process.pid, acquiredAt: new Date().toISOString() };
  // wx provides atomic create: concurrent writers cannot both acquire.
  try { writeFileSync(path, `${JSON.stringify(body, null, 2)}\n`, { encoding: "utf8", flag: "wx" }); return { status: "PASS", path, ...body }; }
  catch { return { schemaVersion: "1.0", status: "BLOCKED", findings: ["Runtime lease is already held."] }; }
}

export function diagnosticsBundle(repositoryRoot: string, outputPath?: string): Record<string, unknown> {
  const repo = resolve(repositoryRoot);
  if (!isInside(repo, repo)) return { schemaVersion: "1.0", status: "BLOCKED", code: "REPOSITORY_UNSAFE", message: "Diagnostics repository is unsafe." };
  if (outputPath !== undefined && isAbsolute(outputPath)) return { schemaVersion: "1.0", status: "BLOCKED", code: "PATH_UNSAFE", message: "Diagnostics output must be repository-relative." };
  const output = resolve(repo, outputPath ?? join(".infoapex-ai", "diagnostics", `bundle-${Date.now()}.json`));
  if (!isInside(repo, output) || !safeExistingParent(repo, output)) return { schemaVersion: "1.0", status: "BLOCKED", code: "PATH_UNSAFE", message: "Diagnostics output must remain inside the repository." };
  const value = { schemaVersion: "1.0", generatedAt: new Date().toISOString(), repositoryHash: hash(repo), production: productionDoctor(repo), config: explainConfig(repo), environment: { platform: process.platform, architecture: process.arch, node: process.version }, note: "No source, configuration values, environment variables, or raw provider output included." };
  mkdirSync(dirname(output), { recursive: true }); writeFileSync(output, `${JSON.stringify(value, null, 2)}\n`, "utf8"); return { status: "PASS", output, sha256: hash(readFileSync(output)), redacted: true };
}

export function retention(repositoryRoot: string, dryRun = true): Record<string, unknown> {
  const repo = resolve(repositoryRoot); const policyPath = join(repo, ".infoapex-ai", "production-policy.json");
  let policy: ProductionPolicy;
  try { policy = JSON.parse(readFileSync(policyPath, "utf8")) as ProductionPolicy; } catch { return { schemaVersion: "1.0", status: "BLOCKED", code: "POLICY_INVALID", message: "Production retention policy is missing or invalid." }; }
  if (!Number.isInteger(policy.retentionDays) || policy.retentionDays < 1 || policy.retentionDays > 3650) return { schemaVersion: "1.0", status: "BLOCKED", code: "POLICY_INVALID", message: "Retention days must be an integer between 1 and 3650." };
  const cutoffMs = Date.now() - policy.retentionDays * 86_400_000; const root = join(repo, ".infoapex-ai", "diagnostics"); const expired: string[] = [];
  if (existsSync(root)) {
    if (!isInside(repo, root) || !safeExistingPath(repo, root)) return { schemaVersion: "1.0", status: "BLOCKED", code: "PATH_UNSAFE", message: "Diagnostics retention root is unsafe." };
    for (const name of readdirSync(root)) {
      const path = join(root, name); const entry = lstatSync(path);
      if (entry.isSymbolicLink()) return { schemaVersion: "1.0", status: "BLOCKED", code: "SYMLINK_UNSAFE", message: `Retention refuses symbolic link ${name}.` };
      if (entry.isFile() && entry.mtimeMs < cutoffMs) expired.push(path);
    }
  }
  const deleted: string[] = [];
  if (!dryRun) for (const path of expired) { rmSync(path, { force: false }); deleted.push(path); }
  return { schemaVersion: "1.0", status: "PASS", mode: dryRun ? "dry-run" : "apply", cutoff: new Date(cutoffMs).toISOString(), expired, deleted, remaining: expired.length - deleted.length };
}

function hash(value: string | Buffer): string { return createHash("sha256").update(value).digest("hex"); }
function isInside(root: string, path: string): boolean { const rel = relative(resolve(root), resolve(path)); return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)); }
function safeExistingPath(repo: string, path: string): boolean { try { return isInside(repo, realPath(path)); } catch { return false; } }
function safeExistingParent(repo: string, path: string): boolean { const parent = dirname(path); return existsSync(parent) ? safeExistingPath(repo, parent) : safeExistingParent(repo, parent); }
function realPath(path: string): string { lstatSync(path); return realpathSync(path); }
