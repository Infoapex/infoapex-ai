import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

// Overridable for tests, which point this at a fixture tree instead of the
// real project root. Production invocations (npm run check:generic-boundary)
// are unaffected: the env var is unset, so root stays the repository root.
const root = process.env.APEX_GENERIC_BOUNDARY_ROOT
  ? join(process.env.APEX_GENERIC_BOUNDARY_ROOT)
  : join(fileURLToPath(new URL("..", import.meta.url)));
const forbidden = [
  [112, 97, 99, 111],
  [112, 97, 99, 111, 32, 109, 97, 114, 107, 101, 116],
  [112, 97, 99, 111, 109, 97, 114, 107, 101, 116]
].map((codes) => String.fromCharCode(...codes));
const ignoredDirectories = new Set([".git", "node_modules", "dist", "bin", "obj", "db"]);
// Embedded assets (e.g. base64-encoded PNGs inline in an SVG) are high-entropy
// data, not authored text: any forbidden term can appear there by pure chance.
// Strip the encoded payload before scanning, not the whole file, so a real
// forbidden reference sitting next to an embedded image is still caught.
const dataUriPayload = /data:[a-z0-9.+-]+\/[a-z0-9.+-]+;base64,[a-z0-9+/=]+/gi;
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

    const scannable = contents.replace(dataUriPayload, "");
    if (forbidden.some((term) => new RegExp(term, "i").test(scannable))) {
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
