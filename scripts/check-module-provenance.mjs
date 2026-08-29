import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

const root = fileURLToPath(new URL("..", import.meta.url));
const manifestPath = resolve(root, "modules", "provenance.json");
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
const failures = [];
const names = new Set();
const requiredModules = new Map([
  ["ai-code-control", "modules/ai-code-control"],
  ["ai-code-worker", "modules/ai-code-worker"],
  ["ai-code-planner", "modules/ai-code-planner"]
]);

if (manifest.schemaVersion !== "1.0" || !Array.isArray(manifest.modules)) {
  failures.push("modules/provenance.json must use schemaVersion 1.0 and declare a modules array");
} else {
  for (const module of manifest.modules) {
    if (!module.name || names.has(module.name)) failures.push(`invalid or duplicate module name: ${module.name ?? "<missing>"}`);
    names.add(module.name);
    if (!requiredModules.has(module.name)) failures.push(`unexpected standalone module: ${module.name}`);
    if (module.sourceRepository !== `https://github.com/Infoapex/${module.name}.git`) {
      failures.push(`${module.name}: invalid canonical sourceRepository`);
    }
    if (!/^[0-9a-f]{40}$/.test(module.sourceCommit ?? "")) failures.push(`${module.name}: sourceCommit is not a full Git SHA`);
    if (module.sourceBranch !== "main") failures.push(`${module.name}: sourceBranch must be main`);
    if (module.bundlePath !== requiredModules.get(module.name) || !existsSync(resolve(root, module.bundlePath ?? ""))) {
      failures.push(`${module.name}: bundlePath does not exist`);
    }
    if (!Array.isArray(module.allowedAdaptations)) failures.push(`${module.name}: allowedAdaptations must be an array`);
  }

  for (const name of requiredModules.keys()) {
    if (!names.has(name)) failures.push(`missing standalone module pin: ${name}`);
  }
}

if (failures.length > 0) {
  console.error("Module provenance check failed:");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exitCode = 1;
} else {
  console.log(`Module provenance check passed for ${manifest.modules.length} canonical modules.`);
}
