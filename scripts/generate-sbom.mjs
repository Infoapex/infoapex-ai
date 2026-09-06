import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// P6.2 local SBOM: deterministic inventory of package-lock inputs. Signing and
// publication remain an explicit release-owner action; this script never uploads.
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const output = resolve(root, option("--out") ?? positional() ?? "dist-release/sbom.cdx.json");
const locks = ["package-lock.json", "modules/ai-code-planner/package-lock.json", "modules/ai-code-worker/package-lock.json", "modules/ai-code-review/package-lock.json", "modules/ai-code-docs/package-lock.json", "modules/ai-code-benchmark/package-lock.json", "modules/ai-code-control/tools/ai-code-control/mcp-server/package-lock.json"];
const components = locks.filter((path) => existsSync(join(root, path))).map((path) => ({ type: "library", name: path, version: createHash("sha256").update(readFileSync(join(root, path))).digest("hex"), hashes: [{ alg: "SHA-256", content: createHash("sha256").update(readFileSync(join(root, path))).digest("hex") }] }));
mkdirSync(dirname(output), { recursive: true });
writeFileSync(output, `${JSON.stringify({ bomFormat: "CycloneDX", specVersion: "1.5", serialNumber: `urn:uuid:${createHash("sha256").update(components.map((c) => c.version).join("")).digest("hex").slice(0, 32)}`, version: 1, metadata: { component: { type: "application", name: "@infoapex/infoapex-ai" } }, components }, null, 2)}\n`);
console.log(JSON.stringify({ status: "PASS", output, components: components.length }, null, 2));
function option(name) { const index = process.argv.indexOf(name); return index < 0 ? null : process.argv[index + 1] ?? null; }
function positional() { return process.argv.slice(2).find((value) => !value.startsWith("--")) ?? null; }
