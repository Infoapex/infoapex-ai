import { execFileSync } from "node:child_process";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const raw = execFileSync(npm, ["pack", "--dry-run", "--json", "--ignore-scripts"], {
  cwd: root,
  encoding: "utf8",
  windowsHide: true,
  shell: process.platform === "win32"
});
const result = JSON.parse(raw)[0];
const files = result.files.map((entry) => entry.path.replaceAll("\\", "/"));
const trackedOrIgnored = new Set(execFileSync("git", ["ls-files", "--others", "--exclude-standard"], {
  cwd: root, encoding: "utf8", windowsHide: true, shell: process.platform === "win32"
}).split(/\r?\n/).filter(Boolean).map((path) => path.replaceAll("\\", "/")));

const required = [
  "dist/src/cli.js",
  "modules/ai-code-planner/dist/src/cli.js",
  "modules/ai-code-worker/dist/src/cli.js",
  "modules/ai-code-review/dist/src/cli.js",
  "modules/ai-code-docs/dist/src/cli.js",
  "modules/ai-code-benchmark/dist/src/cli.js",
  "modules/ai-code-control/tools/ai-code-control/mcp-server/dist/server.js",
  "modules/ai-code-control/tools/ai-code-control/src/AiCodeControl.Cli/AiCodeControl.Cli.csproj",
  "modules/provenance.json",
  "modules/ai-code-worker/templates/project/.ai-code-worker/execution-environment.example.json"
];
const missing = required.filter((path) => !files.includes(path));
const forbidden = files.filter((path) =>
  path === ".git" || path.startsWith(".git/") ||
  path === "node_modules" || path.startsWith("node_modules/") ||
  path === ".infoapex-ai" || path.startsWith(".infoapex-ai/") ||
  path === ".ai-code-control" || path.startsWith(".ai-code-control/") ||
  path === ".ai-code-worker" || path.startsWith(".ai-code-worker/") ||
  path === ".ai-code-review" || path.startsWith(".ai-code-review/") ||
  path === ".ai-code-docs" || path.startsWith(".ai-code-docs/") ||
  path === ".local" || path.includes("/.local/") ||
  path === "validation" || path.startsWith("validation/") || path.includes("/validation/") ||
  path === "dist/tests" || path.startsWith("dist/tests/") ||
  path === ".claude" || path.startsWith(".claude/") || path === ".codex" || path.startsWith(".codex/") ||
  path === ".github" || path.startsWith(".github/") ||
  path === "tests" || path.startsWith("tests/") || path.includes("/tests/") ||
  path === "coverage" || path.startsWith("coverage/") || path === ".env" || path.startsWith(".env.")
);
const untrackedPackaged = files.filter((path) => trackedOrIgnored.has(path));

if (missing.length > 0 || forbidden.length > 0 || untrackedPackaged.length > 0) {
  console.error(JSON.stringify({ status: "BLOCKED", code: "NPM_PACKAGE_CONTENT_INVALID", missing, forbidden, untrackedPackaged }, null, 2));
  process.exitCode = 2;
} else {
  console.log(JSON.stringify({
    status: "PASS",
    package: result.name,
    version: result.version,
    fileCount: files.length,
    unpackedSize: result.unpackedSize,
    requiredRuntimeEntries: required.length
  }, null, 2));
}
