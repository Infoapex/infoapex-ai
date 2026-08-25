import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const root = new URL("../schemas/", import.meta.url);
const files = readdirSync(root).filter((file) => file.endsWith(".json"));
for (const file of files) JSON.parse(readFileSync(new URL(file, root), "utf8"));
console.log(`validated ${files.length} JSON files`);
