import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { readFileSync } from 'node:fs';
import { Ajv2020 } from 'ajv/dist/2020.js';
import addFormatsPlugin from 'ajv-formats';
const addFormats = addFormatsPlugin as unknown as (ajv: Ajv2020) => void;

const schemasDir = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'schemas');

export function loadSchema(schemaFileName: string): unknown {
  const schemaPath = resolve(schemasDir, schemaFileName);
  return JSON.parse(readFileSync(schemaPath, 'utf-8')) as unknown;
}

export function validateAgainstSchema<T>(
  schemaFileName: string,
  data: unknown,
): { valid: true; data: T } | { valid: false; errors: string[] } {
  const schema = loadSchema(schemaFileName);
  const ajv = new Ajv2020({ allErrors: true });
  // ajv-formats v3 is typed against the Ajv base class; double-cast via unknown for interop with Ajv2020
  addFormats(ajv);

  let validate: ReturnType<typeof ajv.compile>;
  try {
    validate = ajv.compile(schema as object);
  } catch (err) {
    return {
      valid: false,
      errors: [`Schema compilation failed: ${err instanceof Error ? err.message : String(err)}`],
    };
  }

  const result = validate(data);
  if (result) {
    return { valid: true, data: data as T };
  }

  const errors = validate.errors
    ? validate.errors.map(e => `${e.instancePath || '(root)'} ${e.message ?? 'unknown error'}`.trim())
    : ['Validation failed'];
  return { valid: false, errors };
}
