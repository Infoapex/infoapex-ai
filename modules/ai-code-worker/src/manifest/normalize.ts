import { createHash } from "node:crypto";
import { SchemaRegistry, type JsonValue } from "../schema/json-schema.js";

export interface FrozenManifest {
  readonly normalized: string;
  readonly sha256: string;
}

export function freezeManifest(manifest: unknown, registry = SchemaRegistry.load()): FrozenManifest {
  registry.assertValid("manifest.schema.json", manifest);

  const normalized = canonicalJson(manifest as JsonValue);

  return {
    normalized,
    sha256: sha256(normalized)
  };
}

export function canonicalJson(value: JsonValue): string {
  return JSON.stringify(sortJson(value));
}

export function sha256(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

function sortJson(value: JsonValue): JsonValue {
  if (Array.isArray(value)) {
    return value.map((item) => sortJson(item));
  }

  if (!value || typeof value !== "object") {
    return value;
  }

  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, sortJson(value[key])])
  );
}
