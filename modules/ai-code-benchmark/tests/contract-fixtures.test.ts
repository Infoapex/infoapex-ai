import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { schemaRegistry } from "../src/schema-registry.js";

const fixturePath = fileURLToPath(new URL("../../tests/fixtures/contracts.json", import.meta.url));
const fixtures = JSON.parse(readFileSync(fixturePath, "utf8")) as { valid: Record<string, unknown>; invalid: Record<string, unknown> };

test("every BENCH-02 contract accepts its valid fixture", () => {
  for (const [schema, value] of Object.entries(fixtures.valid)) schemaRegistry.assertValid(schema, value);
});

test("contract fixtures reject unknown properties, dangling-style IDs, and unsafe paths", () => {
  for (const [schema, value] of Object.entries(fixtures.invalid)) assert.throws(() => schemaRegistry.assertValid(schema, value), /JSON schema validation failed/);
});
