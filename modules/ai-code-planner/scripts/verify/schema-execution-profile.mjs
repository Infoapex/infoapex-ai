import { readFileSync } from "node:fs";

const raw = readFileSync("schemas/execution-profile.schema.json", "utf8");
const schema = JSON.parse(raw);
const text = JSON.stringify(schema);

let ok = true;

for (const field of ["engine", "resolvedModel", "fallbacks", "reason", "confidence", "policyVersion"]) {
  if (!text.includes(field)) {
    console.error(`missing field: ${field}`);
    ok = false;
  }
}

process.exit(ok ? 0 : 1);
