import { Ajv2020, type ErrorObject } from "ajv/dist/2020.js";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const schemaDirectory = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "schemas");
const require = createRequire(import.meta.url);
const addFormats = require("ajv-formats") as (ajv: Ajv2020) => Ajv2020;

export class SchemaRegistry {
  private readonly ajv = addFormats(new Ajv2020({ allErrors: true, strict: true, allowUnionTypes: true }));
  private readonly schemas = new Map<string, string>();

  public constructor(directory = schemaDirectory) {
    if (!existsSync(directory)) throw new Error(`Schema directory does not exist: ${directory}`);
    for (const file of readdirSync(directory).filter((name) => name.endsWith(".json")).sort()) {
      const schema = JSON.parse(readFileSync(join(directory, file), "utf8")) as { $id?: string };
      if (!schema.$id) throw new Error(`Schema is missing $id: ${file}`);
      if (this.schemas.has(file) || this.ajv.getSchema(schema.$id)) throw new Error(`Duplicate schema identity: ${file}`);
      this.ajv.addSchema(schema, schema.$id);
      this.schemas.set(file, schema.$id);
    }
    for (const [file, id] of this.schemas) {
      if (!this.ajv.getSchema(id)) throw new Error(`Schema validator unavailable while registering ${file}.`);
    }
  }

  public names(): readonly string[] {
    return [...this.schemas.keys()];
  }

  public assertInstalled(expected: readonly string[]): void {
    const missing = expected.filter((name) => !this.schemas.has(name));
    if (missing.length > 0) throw new Error(`Required schemas are not installed: ${missing.join(", ")}`);
  }

  public assertValid(name: string, value: unknown): void {
    const file = basename(name.endsWith(".json") ? name : `${name}.json`);
    const id = this.schemas.get(file);
    if (!id) throw new Error(`No registered schema named ${file}; BENCH-02 contracts are not installed.`);
    const validator = this.ajv.getSchema(id);
    if (!validator) throw new Error(`Schema validator unavailable for ${file}.`);
    if (!validator(value)) {
      const issues = (validator.errors ?? []).map((error: ErrorObject) => `${error.instancePath || "/"} ${error.message ?? "invalid"}`).join("; ");
      throw new Error(`JSON schema validation failed for ${file}: ${issues}`);
    }
  }
}

export const schemaRegistry = new SchemaRegistry();
