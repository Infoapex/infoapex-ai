import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const directory = new URL("../schemas/", import.meta.url);
const path = fileURLToPath(directory);
const files = existsSync(path) ? readdirSync(path).filter((file) => file.endsWith(".json")).sort() : [];
for (const file of files) JSON.parse(readFileSync(join(path, file), "utf8"));
console.log(`validated ${files.length} JSON schema files`);
