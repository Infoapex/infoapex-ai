import { createPublicKey, sign as createSignature, verify as verifySignature } from "node:crypto";
import { existsSync, lstatSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { canonicalJson, sha256CanonicalJson } from "../canonical-json.js";

export const OTEL_CANDIDATE_MAX_INVOCATIONS = 20 as const;

export interface OtelCandidateAuthorization {
  readonly schemaVersion: "p5-otel-authorization.v1";
  readonly algorithm: "ed25519";
  readonly payload: {
    readonly experimentId: string;
    readonly experimentHash: string;
    readonly hypothesisHash: string;
    readonly provider: "codex";
    readonly maximumInvocations: 20;
    readonly scope: "P5-OTEL";
    readonly approvedBy: string;
    readonly issuedAt: string;
    readonly expiresAt: string;
  };
  readonly publicKeyPem: string;
  readonly signature: string;
}

export function signOtelCandidateAuthorization(payload: OtelCandidateAuthorization["payload"], privateKeyPem: string, publicKeyPem: string): OtelCandidateAuthorization {
  if (payload.maximumInvocations !== OTEL_CANDIDATE_MAX_INVOCATIONS || payload.provider !== "codex" || payload.scope !== "P5-OTEL") throw new Error("Only the frozen bounded P5 OpenTelemetry candidate can be authorized.");
  return { schemaVersion: "p5-otel-authorization.v1", algorithm: "ed25519", payload, publicKeyPem, signature: createSignature(null, Buffer.from(canonicalJson(payload)), privateKeyPem).toString("base64") };
}

export function validateOtelCandidateAuthorization(path: string, expected: { readonly experimentId: string; readonly experimentHash: string; readonly hypothesisHash: string; readonly now?: Date }): OtelCandidateAuthorization {
  const absolute = resolve(path);
  if (!existsSync(absolute) || !lstatSync(absolute).isFile() || lstatSync(absolute).isSymbolicLink()) throw new Error("P5 authorization must be a regular local file.");
  let value: unknown;
  try { value = JSON.parse(readFileSync(absolute, "utf8")); } catch { throw new Error("P5 authorization file is not valid JSON."); }
  if (!record(value) || value.schemaVersion !== "p5-otel-authorization.v1" || value.algorithm !== "ed25519" || !record(value.payload) || typeof value.publicKeyPem !== "string" || typeof value.signature !== "string") throw new Error("Malformed P5 OpenTelemetry authorization file.");
  const payload = value.payload;
  const required = ["experimentId", "experimentHash", "hypothesisHash", "provider", "maximumInvocations", "scope", "approvedBy", "issuedAt", "expiresAt"];
  if (Object.keys(payload).sort().join("|") !== required.sort().join("|") || payload.experimentId !== expected.experimentId || payload.experimentHash !== expected.experimentHash || payload.hypothesisHash !== expected.hypothesisHash || payload.provider !== "codex" || payload.maximumInvocations !== OTEL_CANDIDATE_MAX_INVOCATIONS || payload.scope !== "P5-OTEL" || typeof payload.approvedBy !== "string" || !payload.approvedBy || typeof payload.issuedAt !== "string" || typeof payload.expiresAt !== "string") throw new Error("P5 authorization does not match the frozen candidate experiment.");
  const issued = Date.parse(payload.issuedAt); const expires = Date.parse(payload.expiresAt); const now = (expected.now ?? new Date()).getTime();
  if (!Number.isFinite(issued) || !Number.isFinite(expires) || issued > now + 60_000 || expires <= now || expires <= issued) throw new Error("P5 authorization has an invalid issue or expiry time.");
  let valid = false;
  try { valid = verifySignature(null, Buffer.from(canonicalJson(payload)), createPublicKey(value.publicKeyPem), Buffer.from(value.signature, "base64")); } catch { valid = false; }
  if (!valid) throw new Error("P5 authorization signature is invalid.");
  return value as unknown as OtelCandidateAuthorization;
}

export function otelAuthorizationKeyHash(value: OtelCandidateAuthorization): string { return sha256CanonicalJson(value.publicKeyPem); }
function record(value: unknown): value is Record<string, any> { return typeof value === "object" && value !== null && !Array.isArray(value); }
