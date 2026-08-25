import { Ajv2020, type ErrorObject } from "ajv/dist/2020.js";
import { readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const schemaDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "schemas");
const require = createRequire(import.meta.url);
const addFormats = require("ajv-formats") as (ajv: Ajv2020) => Ajv2020;
const ajv = addFormats(new Ajv2020({ allErrors: true, strict: true }));
const validators = new Map<string, ReturnType<typeof ajv.compile>>();

for (const file of readdirSync(schemaDir).filter((name) => name.endsWith(".json"))) {
  const schema = JSON.parse(readFileSync(join(schemaDir, file), "utf8")) as { $id?: string };
  if (!schema.$id) throw new Error(`Schema is missing $id: ${file}`);
  ajv.addSchema(schema, schema.$id);
  validators.set(file, ajv.getSchema(schema.$id) ?? ajv.compile(schema));
}

export function assertValid(name: string, value: unknown): void {
  const validator = validators.get(basename(name.endsWith(".json") ? name : `${name}.json`));
  if (!validator) throw new Error(`Unknown schema: ${name}`);
  if (!validator(value)) {
    const issues = (validator.errors ?? []).map((error: ErrorObject) => `${error.instancePath || "/"} ${error.message ?? "invalid"}`).join("; ");
    throw new Error(`JSON schema validation failed for ${name}: ${issues}`);
  }
}
