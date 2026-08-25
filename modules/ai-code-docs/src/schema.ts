import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Ajv2020 } from "ajv/dist/2020.js";
import { createRequire } from "node:module";

const root = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const addFormats = require("ajv-formats") as (ajv: Ajv2020) => Ajv2020;

export function assertValid(schemaName: string, value: unknown): void {
  const schema = JSON.parse(readFileSync(join(root, "..", "..", "schemas", schemaName), "utf8")) as object;
  const ajv = addFormats(new Ajv2020({ allErrors: true, strict: true }));
  const validate = ajv.compile(schema);
  if (!validate(value)) throw new Error(`${schemaName}: ${ajv.errorsText(validate.errors)}`);
}
