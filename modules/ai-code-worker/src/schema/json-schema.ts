import { Ajv2020, type ErrorObject, type ValidateFunction } from "ajv/dist/2020.js";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const addFormats = require("ajv-formats") as (ajv: Ajv2020) => Ajv2020;

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

export interface SchemaRegistryOptions {
  readonly schemaDirectory?: string;
}

export interface ValidationResult {
  readonly valid: boolean;
  readonly errors: readonly SchemaValidationIssue[];
}

export interface SchemaValidationIssue {
  readonly instancePath: string;
  readonly schemaPath: string;
  readonly keyword: string;
  readonly message: string;
}

export class SchemaValidationError extends Error {
  readonly schemaName: string;
  readonly issues: readonly SchemaValidationIssue[];

  constructor(schemaName: string, issues: readonly SchemaValidationIssue[]) {
    super(`JSON schema validation failed for ${schemaName}: ${formatIssues(issues)}`);
    this.name = "SchemaValidationError";
    this.schemaName = schemaName;
    this.issues = issues;
  }
}

export class SchemaRegistry {
  private readonly validatorsByName = new Map<string, ValidateFunction>();

  private constructor(private readonly ajv: Ajv2020) {}

  static load(options: SchemaRegistryOptions = {}): SchemaRegistry {
    const schemaDirectory = resolve(options.schemaDirectory ?? defaultSchemaDirectory());
    const registry = new SchemaRegistry(
      addFormats(
        new Ajv2020({
          allErrors: true,
          strict: true
        })
      )
    );

    for (const file of listJsonFiles(schemaDirectory)) {
      const schema = readJsonFile(file);
      const schemaId = schema.$id;

      if (typeof schemaId !== "string" || !schemaId) {
        throw new Error(`JSON schema missing $id: ${file}`);
      }

      registry.ajv.addSchema(schema);
      registry.validatorsByName.set(basename(file), registry.ajv.getSchema(schemaId) ?? registry.ajv.compile(schema));
    }

    return registry;
  }

  validate(schemaName: string, value: unknown): ValidationResult {
    const validate = this.getValidator(schemaName);
    const valid = validate(value);

    return {
      valid,
      errors: valid ? [] : normalizeErrors(validate.errors ?? [])
    };
  }

  assertValid(schemaName: string, value: unknown): void {
    const result = this.validate(schemaName, value);

    if (!result.valid) {
      throw new SchemaValidationError(schemaName, result.errors);
    }
  }

  private getValidator(schemaName: string): ValidateFunction {
    const normalizedName = schemaName.endsWith(".json") ? schemaName : `${schemaName}.json`;
    const validator = this.validatorsByName.get(normalizedName);

    if (!validator) {
      throw new Error(`Unknown JSON schema: ${schemaName}`);
    }

    return validator;
  }
}

function defaultSchemaDirectory(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "schemas");
}

function listJsonFiles(directory: string): string[] {
  const files: string[] = [];

  for (const entry of readdirSync(directory)) {
    const fullPath = join(directory, entry);
    const stats = statSync(fullPath);

    if (stats.isDirectory()) {
      files.push(...listJsonFiles(fullPath));
      continue;
    }

    if (entry.endsWith(".json")) {
      files.push(fullPath);
    }
  }

  return files.sort((left, right) => relative(directory, left).localeCompare(relative(directory, right)));
}

function readJsonFile(file: string): Record<string, unknown> {
  return JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
}

function normalizeErrors(errors: readonly ErrorObject[]): SchemaValidationIssue[] {
  return errors.map((error) => ({
    instancePath: error.instancePath || "/",
    schemaPath: error.schemaPath,
    keyword: error.keyword,
    message: error.message ?? "validation failed"
  }));
}

function formatIssues(issues: readonly SchemaValidationIssue[]): string {
  return issues.map((issue) => `${issue.instancePath} ${issue.message}`).join("; ");
}
