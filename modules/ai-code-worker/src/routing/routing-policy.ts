import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface RoutingCandidate {
  readonly engine: "codex" | "claude";
  readonly model: string | null;
}

export interface RoutingProfile {
  readonly candidates: readonly RoutingCandidate[];
  readonly reason: string;
  readonly confidence: "low" | "medium" | "high";
}

export interface RoutingPolicy {
  readonly schemaVersion: "1.0";
  readonly policyVersion: string;
  readonly profiles: Readonly<Record<string, RoutingProfile>>;
}

export interface FrozenRoutingSnapshot {
  readonly profile: string;
  readonly candidates: readonly RoutingCandidate[];
  readonly reason: string;
  readonly confidence: "low" | "medium" | "high";
  readonly policyVersion: string;
}

export function loadRoutingPolicy(repositoryRoot: string): RoutingPolicy | null {
  const path = join(repositoryRoot, ".ai-code-worker", "routing-policy.json");
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, "utf8")) as RoutingPolicy;
}

export function resolveRoutingProfile(repositoryRoot: string, profileName: string): FrozenRoutingSnapshot | null {
  const policy = loadRoutingPolicy(repositoryRoot);
  const profile = policy?.profiles[profileName];
  if (!policy || !profile || profile.candidates.length === 0) return null;
  return {
    profile: profileName,
    candidates: profile.candidates,
    reason: profile.reason,
    confidence: profile.confidence,
    policyVersion: policy.policyVersion
  };
}

