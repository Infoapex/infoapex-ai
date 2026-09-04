import { createPublicKey, sign as createSignature, verify as verifySignature } from "node:crypto";
import { existsSync, lstatSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { sha256CanonicalJson, canonicalJson } from "../canonical-json.js";

export interface PilotAuthorization {
  readonly schemaVersion: "bench-pilot-authorization.v1";
  readonly algorithm: "ed25519";
  readonly payload: { readonly experimentId: string; readonly experimentHash: string; readonly provider: "codex"; readonly maximumInvocations: 30; readonly scope: "BENCH-09"; readonly approvedBy: string; readonly issuedAt: string; readonly expiresAt: string };
  readonly publicKeyPem: string;
  readonly signature: string;
}

/** Validate an explicit local approval before a live process can be started. */
export function validatePilotAuthorization(path: string, expected: { readonly experimentId: string; readonly experimentHash: string; readonly maximumInvocations: number; readonly provider: string; readonly now?: Date }): PilotAuthorization {
  const absolute = resolve(path);
  if (!existsSync(absolute) || !lstatSync(absolute).isFile() || lstatSync(absolute).isSymbolicLink()) throw new Error("Authorization must be a regular local file.");
  let value: unknown;
  try { value = JSON.parse(readFileSync(absolute, "utf8")); } catch { throw new Error("Authorization file is not valid JSON."); }
  if (!isRecord(value) || value.schemaVersion !== "bench-pilot-authorization.v1" || value.algorithm !== "ed25519" || !isRecord(value.payload) || typeof value.publicKeyPem !== "string" || typeof value.signature !== "string") throw new Error("Malformed BENCH-09 authorization file.");
  const payload = value.payload;
  const required = ["experimentId", "experimentHash", "provider", "maximumInvocations", "scope", "approvedBy", "issuedAt", "expiresAt"];
  if (Object.keys(payload).sort().join("|") !== required.sort().join("|") || payload.experimentId !== expected.experimentId || payload.experimentHash !== expected.experimentHash || payload.provider !== expected.provider || payload.maximumInvocations !== expected.maximumInvocations || payload.scope !== "BENCH-09" || typeof payload.approvedBy !== "string" || !payload.approvedBy || typeof payload.expiresAt !== "string") throw new Error("Authorization does not match the frozen pilot matrix.");
  const expires = Date.parse(payload.expiresAt); if (!Number.isFinite(expires) || expires <= (expected.now ?? new Date()).getTime()) throw new Error("Authorization is expired or has an invalid expiry.");
  let valid = false;
  try { valid = verifySignature(null, Buffer.from(canonicalJson(payload)), createPublicKey(value.publicKeyPem), Buffer.from(value.signature, "base64")); } catch { valid = false; }
  if (!valid) throw new Error("Authorization signature is invalid.");
  return value as unknown as PilotAuthorization;
}

export function authorizationKeyHash(authorization: PilotAuthorization): string { return sha256CanonicalJson(authorization.publicKeyPem); }
export function signPilotAuthorization(payload: PilotAuthorization["payload"], privateKeyPem: string, publicKeyPem: string): PilotAuthorization {
  if (payload.maximumInvocations !== 30 || payload.provider !== "codex" || payload.scope !== "BENCH-09") throw new Error("Only the preregistered BENCH-09 matrix can be authorized.");
  return { schemaVersion: "bench-pilot-authorization.v1", algorithm: "ed25519", payload, publicKeyPem, signature: createSignature(null, Buffer.from(canonicalJson(payload)), privateKeyPem).toString("base64") };
}
function isRecord(value: unknown): value is Record<string, any> { return typeof value === "object" && value !== null && !Array.isArray(value); }
