import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
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
  const repo = resolve(repositoryRoot); const output = resolve(repo, outputPath ?? join(".infoapex-ai", "diagnostics", `bundle-${Date.now()}.json`));
  if (!isInside(repo, output)) return { schemaVersion: "1.0", status: "BLOCKED", message: "Diagnostics output must remain inside the repository." };
  const value = { schemaVersion: "1.0", generatedAt: new Date().toISOString(), repositoryHash: hash(repo), production: productionDoctor(repo), config: explainConfig(repo), environment: { platform: process.platform, architecture: process.arch, node: process.version }, note: "No source, configuration values, environment variables, or raw provider output included." };
  mkdirSync(dirname(output), { recursive: true }); writeFileSync(output, `${JSON.stringify(value, null, 2)}\n`, "utf8"); return { status: "PASS", output, sha256: hash(readFileSync(output)), redacted: true };
}

export function retention(repositoryRoot: string, dryRun = true): Record<string, unknown> {
  const repo = resolve(repositoryRoot); const policy = JSON.parse(readFileSync(join(repo, ".infoapex-ai", "production-policy.json"), "utf8")) as ProductionPolicy;
  const cutoff = Date.now() - policy.retentionDays * 86_400_000; const roots = [join(repo, ".infoapex-ai", "diagnostics")]; const expired: string[] = [];
  for (const root of roots) if (existsSync(root)) for (const name of readdirSync(root)) { const path = join(root, name); if (statSync(path).isFile() && statSync(path).mtimeMs < cutoff) expired.push(path); }
  // Destructive deletion is intentionally not automatic in P6 core-local. The
  // inventory is evidence; an operator performs deletion through an approved lifecycle action.
  return { schemaVersion: "1.0", status: "PASS", mode: dryRun ? "dry-run" : "approval-required", cutoff: new Date(cutoff).toISOString(), expired };
}

function hash(value: string | Buffer): string { return createHash("sha256").update(value).digest("hex"); }
function isInside(root: string, path: string): boolean { const relative = path.slice(root.length); return path === root || ((relative.startsWith("\\") || relative.startsWith("/")) && !relative.includes("..")); }
