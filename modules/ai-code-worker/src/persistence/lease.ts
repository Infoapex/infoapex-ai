import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { dirname } from "node:path";

export interface RunLease {
  readonly schemaVersion: "1.0";
  readonly runId: string;
  readonly coordinatorId: string;
  readonly host: string;
  readonly pid: number;
  readonly processStartTime: string;
  readonly heartbeatAt: string;
}

export interface LeaseStatus {
  readonly state: "missing" | "active" | "expired";
  readonly lease: RunLease | null;
}

export function writeLease(path: string, lease: RunLease): RunLease {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(lease, null, 2)}\n`, "utf8");

  return lease;
}

export function readLease(path: string): RunLease | null {
  if (!existsSync(path)) {
    return null;
  }

  return JSON.parse(readFileSync(path, "utf8")) as RunLease;
}

export function createLease(runId: string, coordinatorId: string, now: string): RunLease {
  return {
    schemaVersion: "1.0",
    runId,
    coordinatorId,
    host: hostname(),
    pid: process.pid,
    processStartTime: new Date(Date.now() - process.uptime() * 1000).toISOString(),
    heartbeatAt: now
  };
}

export function evaluateLease(path: string, now: string, maximumHeartbeatAgeMs: number): LeaseStatus {
  const lease = readLease(path);

  if (!lease) {
    return { state: "missing", lease: null };
  }

  const ageMs = Date.parse(now) - Date.parse(lease.heartbeatAt);

  return {
    state: ageMs > maximumHeartbeatAgeMs ? "expired" : "active",
    lease
  };
}
