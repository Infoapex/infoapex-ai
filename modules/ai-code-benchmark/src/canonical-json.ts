import { createHash } from "node:crypto";

/** A JSON-only canonical form: object keys are sorted and text line endings are LF. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(normalize(value));
}

export function sha256CanonicalJson(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}

function normalize(value: unknown): unknown {
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "string") return value.replace(/\r\n?/g, "\n");
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("Canonical JSON does not allow non-finite numbers.");
    return value;
  }
  if (Array.isArray(value)) return value.map(normalize);
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(Object.keys(record).sort().map((key) => [key, normalize(record[key])]));
  }
  throw new Error(`Canonical JSON does not allow ${typeof value} values.`);
}
