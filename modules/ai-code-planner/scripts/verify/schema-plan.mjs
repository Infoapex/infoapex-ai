import { readFileSync } from "node:fs";

const raw = readFileSync("schemas/plan.schema.json", "utf8");
const schema = JSON.parse(raw);

let ok = true;

function check(condition, label) {
  if (!condition) {
    console.error(`failed: ${label}`);
    ok = false;
  }
}

function resolveRef(node) {
  if (node && typeof node === "object" && typeof node.$ref === "string" && node.$ref.startsWith("#/$defs/")) {
    const defName = node.$ref.slice("#/$defs/".length);
    return schema.$defs?.[defName];
  }
  return node;
}

check(schema.$schema === "https://json-schema.org/draft/2020-12/schema", "$schema is draft 2020-12");
check(typeof schema.$id === "string" && schema.$id.length > 0, "$id is set");
check(schema.additionalProperties === false, "top-level additionalProperties is false");

const required = schema.required ?? [];
check(required.includes("goal"), "required includes goal");
check(required.includes("tasks"), "required includes tasks");

const tasksItemsRaw = schema.properties?.tasks?.items;
const taskItems = resolveRef(tasksItemsRaw);
check(taskItems !== undefined, "properties.tasks.items (resolved through $ref if present) is defined");

if (taskItems) {
  const taskRequired = taskItems.required ?? [];
  for (const field of ["id", "goal", "acceptanceCriteria", "gates", "dependsOn", "scope", "requiredInputs"]) {
    check(taskRequired.includes(field), `task.required includes ${field}`);
  }
  check(taskItems.additionalProperties === false, "task additionalProperties is false");
}

process.exit(ok ? 0 : 1);
