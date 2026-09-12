import { createHash, randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { atomicWriteJson } from "./state/atomic-file.js";
import { telemetrySummary } from "./telemetry/run-telemetry.js";

export type OperabilityStatus = "PASS" | "BLOCKED" | "UNKNOWN";
export interface ProductionPolicy {
  readonly schemaVersion: "1.0";
  readonly profile: "core-local";
  readonly externalActions: "disabled";
  readonly telemetryExport: "off";
  readonly rawConversationStorage: false;
  readonly retentionDays: number;
  readonly resources: { readonly maximumRunMinutes: number; readonly maximumOutputBytes: number; readonly maximumParallelWriters: number; readonly staleLeaseMinutes: number };
}

const CONFIGURED_MODULES = [["ai-code-worker", ".ai-code-worker/config.json"], ["ai-code-review", ".ai-code-review/config.json"], ["ai-code-docs", ".ai-code-docs/config.json"]] as const;
const ISOLATION_CONFIG = ".ai-code-control/config/code-control.json";
const SUPPORT_MAX_BYTES = 256 * 1024;

export function defaultProductionPolicy(): ProductionPolicy { return { schemaVersion: "1.0", profile: "core-local", externalActions: "disabled", telemetryExport: "off", rawConversationStorage: false, retentionDays: 30, resources: { maximumRunMinutes: 30, maximumOutputBytes: 2_000_000, maximumParallelWriters: 1, staleLeaseMinutes: 60 } }; }

/** A bounded, non-probing readiness view. It never reads provider output or emits settings. */
export function productionHealth(repositoryRoot: string): Record<string, unknown> {
  const repo = resolve(repositoryRoot); const policy = readPolicy(repo);
  const root = component(policy && validPolicy(policy) ? "PASS" : "BLOCKED", policy ? "POLICY_VALID" : "POLICY_INVALID");
  const modules = CONFIGURED_MODULES.map(([name, file]) => {
    const state = jsonFileState(join(repo, file));
    return { name, configured: state !== "MISSING", ...component(state === "VALID" ? "PASS" : state === "MISSING" ? "UNKNOWN" : "BLOCKED", state === "VALID" ? "MODULE_CONFIG_VALID" : state === "MISSING" ? "MODULE_NOT_CONFIGURED" : "MODULE_CONFIG_INVALID") };
  });
  const worker = jsonFile(join(repo, ".ai-code-worker/config.json"));
  const providerConfigured = isObject(worker) && isObject(worker.provider) && typeof worker.provider.engine === "string" && worker.provider.engine.length > 0 && worker.provider.fallback === "disabled";
  const provider = component(providerConfigured ? "UNKNOWN" : "BLOCKED", providerConfigured ? "PROVIDER_NOT_PROBED" : "PROVIDER_POLICY_INVALID");
  const isolationState = jsonFileState(join(repo, ISOLATION_CONFIG));
  const isolationBackend = component(isolationState === "VALID" ? "UNKNOWN" : isolationState === "MISSING" ? "UNKNOWN" : "BLOCKED", isolationState === "VALID" ? "ISOLATION_NOT_PROBED" : isolationState === "MISSING" ? "ISOLATION_NOT_CONFIGURED" : "ISOLATION_CONFIG_INVALID");
  const statuses = [root.status as OperabilityStatus, ...modules.map((entry) => entry.status as OperabilityStatus), provider.status as OperabilityStatus, isolationBackend.status as OperabilityStatus];
  return { schemaVersion: "1.0", status: aggregate(statuses), probe: "configuration-only", components: { root, modules, provider, isolationBackend }, note: "No provider or sandbox process was invoked; configuration values and process output are never included." };
}

export function productionDoctor(repositoryRoot: string): Record<string, unknown> {
  const repo = resolve(repositoryRoot); const policy = readPolicy(repo); const findings: string[] = [];
  if (!policy) findings.push("Missing or invalid production-policy.json.");
  else if (!validPolicy(policy)) findings.push("Production defaults or resource/retention bounds are invalid.");
  const lease = join(repo, ".infoapex-ai", "runtime", "lease.json");
  if (existsSync(lease) && policy && validPolicy(policy)) { const age = Date.now() - statSync(lease).mtimeMs; findings.push(age > policy.resources.staleLeaseMinutes * 60_000 ? "A stale runtime lease requires explicit recovery." : "An active runtime lease already exists."); }
  const health = productionHealth(repo);
  return { schemaVersion: "1.0", status: findings.length === 0 ? "PASS" : "BLOCKED", code: findings.length === 0 ? "PRODUCTION_POLICY_VALID" : "PRODUCTION_POLICY_INVALID", findings, health };
}

export interface LeaseOptions { readonly staleLeaseMinutes?: number; readonly now?: Date; }
export function acquireLease(repositoryRoot: string, runId: string, options: LeaseOptions = {}): Record<string, unknown> {
  const repo = resolve(repositoryRoot); const doctor = productionDoctor(repo); if (doctor.status !== "PASS") return doctor;
  const path = join(repo, ".infoapex-ai", "runtime", "lease.json"); mkdirSync(dirname(path), { recursive: true });
  const body = { schemaVersion: "1.0", leaseId: randomUUID(), runId, processId: process.pid, acquiredAt: (options.now ?? new Date()).toISOString() };
  try { writeFileSync(path, `${JSON.stringify(body, null, 2)}\n`, { encoding: "utf8", flag: "wx" }); return { status: "PASS", path, ...body }; }
  catch { return { schemaVersion: "1.0", status: "BLOCKED", code: "LEASE_ACTIVE", findings: ["Runtime lease is already held."] }; }
}

/** Recover only a demonstrably stale, parseable lease. */
export function recoverStaleLease(repositoryRoot: string, runId: string, options: LeaseOptions = {}): Record<string, unknown> {
  const repo = resolve(repositoryRoot); const policy = readPolicy(repo); if (!policy || !validPolicy(policy)) return { schemaVersion: "1.0", status: "BLOCKED", code: "POLICY_INVALID" };
  const path = join(repo, ".infoapex-ai", "runtime", "lease.json"); if (!existsSync(path)) return acquireLease(repo, runId, options);
  let lease: { leaseId?: unknown; runId?: unknown; acquiredAt?: unknown };
  try { lease = JSON.parse(readFileSync(path, "utf8")) as typeof lease; } catch { return { schemaVersion: "1.0", status: "BLOCKED", code: "LEASE_INVALID", message: "Lease is malformed and was left untouched." }; }
  if (typeof lease.leaseId !== "string" || typeof lease.runId !== "string" || typeof lease.acquiredAt !== "string" || !Number.isFinite(Date.parse(lease.acquiredAt))) return { schemaVersion: "1.0", status: "BLOCKED", code: "LEASE_INVALID", message: "Lease is malformed and was left untouched." };
  const limit = (options.staleLeaseMinutes ?? policy.resources.staleLeaseMinutes) * 60_000;
  if ((options.now ?? new Date()).getTime() - Date.parse(lease.acquiredAt) <= limit) return { schemaVersion: "1.0", status: "BLOCKED", code: "LEASE_ACTIVE", message: "Runtime lease is active; concurrent runs are rejected." };
  const evidence = join(dirname(path), "recovery", `${lease.leaseId}.stale-lease.json`); mkdirSync(dirname(evidence), { recursive: true });
  try { renameSync(path, evidence); } catch { return { schemaVersion: "1.0", status: "BLOCKED", code: "LEASE_RECOVERY_RACE", message: "Lease changed while stale recovery was attempted." }; }
  atomicWriteJson(`${evidence}.decision.json`, { schemaVersion: "1.0", code: "STALE_LEASE_RECOVERED", recoveredAt: (options.now ?? new Date()).toISOString(), priorRunId: lease.runId });
  return acquireLease(repo, runId, options);
}

export function releaseLease(repositoryRoot: string, runId: string): Record<string, unknown> {
  const path = join(resolve(repositoryRoot), ".infoapex-ai", "runtime", "lease.json"); if (!existsSync(path)) return { schemaVersion: "1.0", status: "PASS", released: false };
  try { const lease = JSON.parse(readFileSync(path, "utf8")) as { runId?: unknown }; if (lease.runId !== runId) return { schemaVersion: "1.0", status: "BLOCKED", code: "LEASE_NOT_OWNER" }; rmSync(path); return { schemaVersion: "1.0", status: "PASS", released: true }; }
  catch { return { schemaVersion: "1.0", status: "BLOCKED", code: "LEASE_INVALID" }; }
}

/** Generates one local-only support artifact. Existing targets and unsafe paths are refused. */
export function diagnosticsBundle(repositoryRoot: string, outputPath?: string): Record<string, unknown> {
  const repo = resolve(repositoryRoot);
  if (!isInside(repo, repo)) return blocked("REPOSITORY_UNSAFE", "Diagnostics repository is unsafe.");
  if (outputPath !== undefined && isAbsolute(outputPath)) return blocked("PATH_UNSAFE", "Diagnostics output must be repository-relative.");
  const output = resolve(repo, outputPath ?? join(".infoapex-ai", "diagnostics", `bundle-${Date.now()}-${randomUUID()}.json`));
  if (!isInside(repo, output) || !safeExistingParent(repo, output) || existsSync(output)) return blocked("PATH_UNSAFE", "Diagnostics output must be a new regular file inside the repository.");
  const policy = readPolicy(repo); if (!policy || !validPolicy(policy)) return blocked("POLICY_INVALID", "A valid local production policy is required before evidence is generated.");
  const telemetry = telemetrySummary(repo);
  const value = { schemaVersion: "1.0", kind: "infoapex-ai-support-bundle", generatedAt: new Date().toISOString(), localOnly: true, automaticUpload: false, repositoryHash: hash(repo), health: productionHealth(repo), telemetry, environment: { platform: process.platform, architecture: process.arch, nodeMajor: Number(process.versions.node.split(".")[0]) }, redaction: { rawTranscripts: "excluded", configurationValues: "excluded", environmentVariables: "excluded", providerProcessOutput: "excluded" } };
  const encoded = `${JSON.stringify(value, null, 2)}\n`; const limit = Math.min(policy.resources.maximumOutputBytes, SUPPORT_MAX_BYTES);
  if (Buffer.byteLength(encoded, "utf8") > limit) return blocked("BUNDLE_SIZE_LIMIT", "Redacted support evidence exceeds its local size limit.");
  try { mkdirSync(dirname(output), { recursive: true }); writeFileSync(output, encoded, { encoding: "utf8", flag: "wx" }); } catch { return blocked("BUNDLE_WRITE_FAILED", "Support bundle could not be written safely."); }
  return { schemaVersion: "1.0", status: "PASS", code: "SUPPORT_BUNDLE_CREATED", output, sha256: hash(encoded), bytes: Buffer.byteLength(encoded, "utf8"), maximumBytes: limit, redacted: true, localOnly: true, automaticUpload: false };
}

export function retention(repositoryRoot: string, dryRun = true): Record<string, unknown> {
  const repo = resolve(repositoryRoot); const policy = readPolicy(repo);
  if (!policy || !Number.isInteger(policy.retentionDays) || policy.retentionDays < 1 || policy.retentionDays > 3650) return blocked("POLICY_INVALID", "Retention days must be an integer between 1 and 3650.");
  const cutoffMs = Date.now() - policy.retentionDays * 86_400_000; const expired: string[] = [];
  for (const directory of ["diagnostics", "telemetry"]) {
    const root = join(repo, ".infoapex-ai", directory); if (!existsSync(root)) continue;
    if (!isInside(repo, root) || !safeExistingPath(repo, root)) return blocked("PATH_UNSAFE", "Local evidence retention root is unsafe.");
    for (const name of readdirSync(root)) { const path = join(root, name); const entry = lstatSync(path); if (entry.isSymbolicLink()) return blocked("SYMLINK_UNSAFE", `Retention refuses symbolic link ${name}.`); if (entry.isFile() && entry.mtimeMs < cutoffMs) expired.push(path); }
  }
  const deleted: string[] = []; if (!dryRun) for (const path of expired) { rmSync(path, { force: false }); deleted.push(path); }
  return { schemaVersion: "1.0", status: "PASS", code: "RETENTION_EVALUATED", mode: dryRun ? "dry-run" : "apply", export: "off", cutoff: new Date(cutoffMs).toISOString(), expired, deleted, remaining: expired.length - deleted.length };
}

function component(status: OperabilityStatus, code: string): { status: OperabilityStatus; code: string } { return { status, code }; }
function aggregate(statuses: readonly OperabilityStatus[]): OperabilityStatus { return statuses.includes("BLOCKED") ? "BLOCKED" : statuses.includes("UNKNOWN") ? "UNKNOWN" : "PASS"; }
function blocked(code: string, message: string): Record<string, unknown> { return { schemaVersion: "1.0", status: "BLOCKED", code, message }; }
function validPolicy(policy: ProductionPolicy): boolean { return policy.schemaVersion === "1.0" && policy.profile === "core-local" && policy.externalActions === "disabled" && policy.telemetryExport === "off" && policy.rawConversationStorage === false && Number.isInteger(policy.retentionDays) && policy.retentionDays >= 1 && policy.retentionDays <= 3650 && Number.isInteger(policy.resources?.maximumRunMinutes) && policy.resources.maximumRunMinutes >= 1 && Number.isInteger(policy.resources.maximumOutputBytes) && policy.resources.maximumOutputBytes >= 1024 && policy.resources.maximumParallelWriters === 1 && Number.isInteger(policy.resources.staleLeaseMinutes) && policy.resources.staleLeaseMinutes >= 1; }
function jsonFileState(path: string): "VALID" | "INVALID" | "MISSING" { if (!existsSync(path)) return "MISSING"; return jsonFile(path) === null ? "INVALID" : "VALID"; }
function jsonFile(path: string): Record<string, unknown> | null { try { const value: unknown = JSON.parse(readFileSync(path, "utf8")); return isObject(value) ? value : null; } catch { return null; } }
function isObject(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value); }
function hash(value: string | Buffer): string { return createHash("sha256").update(value).digest("hex"); }
function readPolicy(repo: string): ProductionPolicy | null { const value = jsonFile(join(repo, ".infoapex-ai", "production-policy.json")); return value as ProductionPolicy | null; }
function isInside(root: string, path: string): boolean { const rel = relative(resolve(root), resolve(path)); return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)); }
function safeExistingPath(repo: string, path: string): boolean { try { return isInside(repo, realPath(path)); } catch { return false; } }
function safeExistingParent(repo: string, path: string): boolean { const parent = dirname(path); return existsSync(parent) ? safeExistingPath(repo, parent) : safeExistingParent(repo, parent); }
function realPath(path: string): string { lstatSync(path); return realpathSync(path); }
