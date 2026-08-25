import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(fileURLToPath(new URL("..", import.meta.url)));
const forbidden = [
  [112, 97, 99, 111],
  [112, 97, 99, 111, 32, 109, 97, 114, 107, 101, 116],
  [112, 97, 99, 111, 109, 97, 114, 107, 101, 116]
].map((codes) => String.fromCharCode(...codes));
const ignoredDirectories = new Set([".git", "node_modules", "dist", "bin", "obj", "db"]);
const failures = [];

function visit(directory) {
  for (const entry of readdirSync(directory)) {
    if (ignoredDirectories.has(entry)) continue;

    const path = join(directory, entry);
    const info = statSync(path);
    if (info.isDirectory()) {
      visit(path);
      continue;
    }

    let contents;
    try {
      contents = readFileSync(path, "utf8");
    } catch {
      continue;
    }

    if (forbidden.some((term) => new RegExp(term, "i").test(contents))) {
      failures.push(relative(root, path));
    }
  }
}

visit(root);

if (failures.length > 0) {
  console.error("Bundle files contain a forbidden product-specific reference:");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exitCode = 1;
} else {
  console.log("Generic bundle boundary check passed.");
}
