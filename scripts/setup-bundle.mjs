import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

const root = fileURLToPath(new URL("..", import.meta.url));
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const packageDirectories = [
  ".",
  "modules/ai-code-planner",
  "modules/ai-code-worker",
  "modules/ai-code-review",
  "modules/ai-code-docs",
  "modules/ai-code-control/tools/ai-code-control/mcp-server"
];

for (const directory of packageDirectories) {
  console.log(`Installing dependencies: ${directory}`);
  execFileSync(npm, ["ci"], { cwd: resolve(root, directory), stdio: "inherit", shell: process.platform === "win32" });
}
