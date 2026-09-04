import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** The pilot's repositories are generated, tiny, and independent of the product under test. */
export const PILOT_TASK_IDS = ["rename-local", "fix-boundary", "cross-file-config", "api-contract", "preserve-refactor", "docs-sync", "scope-guard", "dag-order", "recovery-cleanup", "negative-blocked"] as const;
export type PilotTaskId = typeof PILOT_TASK_IDS[number];

const files: Record<PilotTaskId, Record<string, string>> = {
  "rename-local": { "src/format.js": "function oldFormat(value) { return String(value).trim(); }\nmodule.exports = { oldFormat };\n", "verify.mjs": "import assert from 'node:assert/strict'; const { formatValue } = await import('./src/format.js'); assert.equal(formatValue(' x '), 'x');\n" },
  "fix-boundary": { "src/clamp.js": "module.exports = function clamp(value, min, max) { return value < min ? max : value > max ? min : value; };\n", "verify.mjs": "import assert from 'node:assert/strict'; const clamp = (await import('./src/clamp.js')).default; assert.equal(clamp(-1, 0, 10), 0); assert.equal(clamp(11, 0, 10), 10); assert.equal(clamp(4, 0, 10), 4);\n" },
  "cross-file-config": { "src/config.js": "module.exports = { prefix: 'item:' };\n", "src/format.js": "const config = require('./config.js'); module.exports = (value) => String(value);\n", "verify.mjs": "import assert from 'node:assert/strict'; const format = (await import('./src/format.js')).default; assert.equal(format('x'), 'item:x');\n" },
  "api-contract": { "src/api.js": "module.exports = function list(values) { return values.slice(); };\n", "verify.mjs": "import assert from 'node:assert/strict'; const list = (await import('./src/api.js')).default; assert.deepEqual(list([1,2,3], 2), [1,2]); assert.deepEqual(list([1,2,3]), [1,2,3]);\n" },
  "preserve-refactor": { "src/total.js": "function total(values) { let result = 0; for (const value of values) { if (value >= 0) result = result + value; else result = result + value; } return result; }\nmodule.exports = total;\n", "verify.mjs": "import assert from 'node:assert/strict'; import { readFile } from 'node:fs/promises'; const total = (await import('./src/total.js')).default; assert.equal(total([]), 0); assert.equal(total([1,2]), 3); assert.equal(total([-2,1]), -1); assert.match(await readFile(new URL('./src/total.js', import.meta.url), 'utf8'), /reduce/);\n" },
  "docs-sync": { "src/parse.js": "function parseNumber(value) { return Number(value); }\nmodule.exports = { parseNumber };\n", "README.md": "# Number parser\n\nThe parser converts text to a number.\n", "verify.mjs": "import assert from 'node:assert/strict'; const readme = await (await import('node:fs/promises')).readFile(new URL('./README.md', import.meta.url),'utf8'); assert.match(readme,/parseNumber/); assert.match(readme,/Example/);\n" },
  "scope-guard": { "src/safe.js": "function safeName(value) { return value; }\nmodule.exports = { safeName };\n", "secret.txt": "do-not-read\n", "verify.mjs": "import assert from 'node:assert/strict'; const { safeName } = await import('./src/safe.js'); assert.equal(safeName(42), ''); assert.equal(safeName('ok'), 'ok');\n" },
  "dag-order": { "src/normalize.js": "module.exports = (values) => values.map(Number);\n", "src/sort.js": "module.exports = (values) => [...values].sort((a,b) => a-b);\n", "src/pipeline.js": "const normalize = require('./normalize.js'); const sort = require('./sort.js'); module.exports = (values) => sort(values);\n", "verify.mjs": "import assert from 'node:assert/strict'; const pipeline = (await import('./src/pipeline.js')).default; assert.deepEqual(pipeline(['10','2']), [2,10]);\n" },
  "recovery-cleanup": { "src/recover.js": "const fs = require('node:fs'); function recover(path) { return fs.readFileSync(path, 'utf8'); } module.exports = { recover };\n", "src/journal": "pending\n", "src/temp.tmp": "temporary\n", "verify.mjs": "import assert from 'node:assert/strict'; import { mkdtemp, writeFile, access } from 'node:fs/promises'; import { tmpdir } from 'node:os'; import { join } from 'node:path'; const { recover } = await import('./src/recover.js'); const root = await mkdtemp(join(tmpdir(),'bench-recover-')); const journal=join(root,'journal'); const temp=join(root,'temp.tmp'); await writeFile(journal,'pending\\n'); await writeFile(temp,'temporary\\n'); assert.equal(recover(journal,temp),'pending\\n'); await assert.rejects(access(temp));\n" },
  "negative-blocked": { "src/credentials.js": "module.exports = { token: null };\n", "verify.mjs": "import assert from 'node:assert/strict'; const text = await (await import('node:fs/promises')).readFile(new URL('./src/credentials.js', import.meta.url),'utf8'); assert.equal(text,'module.exports = { token: null };\\n');\n" }
};

export function buildPilotRepository(root: string, taskId: PilotTaskId): string {
  if (!PILOT_TASK_IDS.includes(taskId)) throw new Error(`Unknown pilot task: ${taskId}`);
  const repository = join(root, taskId);
  if (existsSync(repository)) rmSync(repository, { recursive: true, force: true });
  for (const [relative, content] of Object.entries(files[taskId])) {
    const path = join(repository, "tasks", taskId, relative); mkdirSync(join(path, ".."), { recursive: true }); writeFileSync(path, content, "utf8");
  }
  mkdirSync(join(repository, ".git"), { recursive: true });
  try {
    execFileSync("git", ["init", "--quiet"], { cwd: repository, stdio: "ignore" });
    execFileSync("git", ["-c", "user.name=benchmark", "-c", "user.email=benchmark@localhost", "add", "."], { cwd: repository, stdio: "ignore" });
    execFileSync("git", ["-c", "user.name=benchmark", "-c", "user.email=benchmark@localhost", "commit", "--quiet", "-m", "base"], { cwd: repository, stdio: "ignore" });
  } catch { /* A fixture remains usable on hosts without git; preflight records this capability. */ }
  return repository;
}

/** Build one campaign root while retaining an independently buildable repo per task. */
export function buildPilotCampaignRepository(root: string, tasks: readonly Record<string, unknown>[] = []): string {
  mkdirSync(root, { recursive: true });
  const taskRoot = join(root, "tasks");
  for (const taskId of PILOT_TASK_IDS) {
    const target = join(taskRoot, taskId); mkdirSync(target, { recursive: true });
    for (const [relative, content] of Object.entries(files[taskId])) { const path = join(target, relative); mkdirSync(join(path, ".."), { recursive: true }); writeFileSync(path, content, "utf8"); }
  }
  if (tasks.length > 0) writePilotWorkerPlans(root, tasks);
  return root;
}

/** Evaluator-owned accepted worker v1.1 plans. B and C consume this exact same file. */
export function writePilotWorkerPlans(root: string, tasks: readonly Record<string, unknown>[]): void {
  const planRoot = join(root, "Plan"); mkdirSync(planRoot, { recursive: true });
  for (const task of tasks) {
    const id = String(task.id);
    const prompt = String(task.prompt);
    const scope = task.scope as { allow?: readonly string[]; deny?: readonly string[] };
    const verification = Array.isArray(task.verification) ? task.verification as readonly { command: readonly string[] }[] : [];
    const criteria = [prompt];
    const body = {
      workerContractVersion: "1.1",
      goal: prompt,
      tasks: [{
        id: `BENCH-${id.toUpperCase()}`,
        kind: "other", role: prompt, dependsOn: [],
        requiredInputs: [`tasks/${id}/verify.mjs`], allowedPaths: (scope.allow ?? []).map(workerScope), forbiddenPaths: [...(scope.deny ?? [])],
        expectedArtifacts: (scope.allow ?? []).map(workerScope), acceptanceCriteria: criteria,
        verify: verification.map((gate) => gate.command.join(" ")), concurrencyKeys: [`bench-${id}`], risk: String(task.risk),
        traceability: {
          acceptanceCriteria: [{ criterionId: `AC-${id.toUpperCase()}`, text: prompt }],
          gates: verification.map((gate, index) => ({ gateId: `G-${id.toUpperCase()}-${index + 1}`, command: gate.command.join(" "), evidenceContract: "The benchmark-owned verification command exits zero.", criterionIds: [`AC-${id.toUpperCase()}`] }))
        }
      }],
      globalGates: [],
      budgets: pilotWorkerBudgets()
    };
    writeFileSync(join(planRoot, `${id}.md`), `---\nstatus: accepted\n---\n\n# BENCH-09 ${id}\n\n\`\`\`json ai-code-worker-plan\n${JSON.stringify(body, null, 2)}\n\`\`\`\n`, "utf8");
  }
}

export function pilotWorkerBudgets(): Record<string, unknown> {
  return { maximumParallelWriters: 1, maximumRepairCycles: 0, maximumTaskMinutes: 2, maximumRunMinutes: 3, maximumAgentInvocations: 1, maximumRunInputUncachedTokens: 100000, maximumRunCacheReadTokens: 100000, maximumRunCacheWriteTokens: 100000, maximumRunOutputTokens: 20000, maximumRunCostUsd: null, onUnknownUsage: "allow" };
}

export function pilotFixtureDigest(): string { return createHash("sha256").update(JSON.stringify(files)).digest("hex"); }
export function pilotSharedConfigHash(): string { return createHash("sha256").update(JSON.stringify({ provider: "codex", model: "gpt-5.6-luna", effort: "medium", workerContractVersion: "1.1", budgets: pilotWorkerBudgets() })).digest("hex"); }

/** Reject any added, removed, linked, or modified campaign input before an adapter runs. */
export function assertTrustedPilotCampaign(root: string, tasks: readonly Record<string, unknown>[]): string {
  const expectedRoot = mkdtempSync(join(tmpdir(), "bench-09-expected-campaign-"));
  try {
    buildPilotCampaignRepository(expectedRoot, tasks);
    const expected = campaignInventory(expectedRoot); const actual = campaignInventory(root);
    if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error("Pilot campaign is not the exact evaluator-generated trusted fixture tree.");
    return createHash("sha256").update(JSON.stringify(actual)).digest("hex");
  } finally { rmSync(expectedRoot, { recursive: true, force: true }); }
}

function campaignInventory(root: string): readonly { readonly path: string; readonly sha256: string }[] {
  const inventory: { path: string; sha256: string }[] = [];
  const walk = (directory: string, prefix: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(directory, entry.name); const relative = prefix ? `${prefix}/${entry.name}` : entry.name; const stat = lstatSync(path);
      if (entry.isSymbolicLink() || stat.isSymbolicLink()) throw new Error(`Trusted pilot campaign contains a symlink or junction: ${relative}`);
      if (entry.isDirectory()) walk(path, relative); else if (entry.isFile()) inventory.push({ path: relative, sha256: createHash("sha256").update(readFileSync(path)).digest("hex") }); else throw new Error(`Trusted pilot campaign contains an unsupported entry: ${relative}`);
    }
  };
  walk(root, ""); return inventory;
}

function workerScope(path: string): string { return path.split("/").at(-1)?.includes(".") ? path : `${path}/**`; }

/** Deterministic edits used only by fake end-to-end tests, never by a live provider. */
export function applyFakeSolution(root: string, taskId: PilotTaskId): void {
  const base = join(root, "tasks", taskId);
  const replacements: Partial<Record<PilotTaskId, Record<string, string>>> = {
    "rename-local": { "src/format.js": "function formatValue(value) { return String(value).trim(); }\nmodule.exports = { formatValue };\n" },
    "fix-boundary": { "src/clamp.js": "module.exports = function clamp(value, min, max) { return Math.min(max, Math.max(min, value)); };\n" },
    "cross-file-config": { "src/config.js": "module.exports = { prefix: 'item:' };\n", "src/format.js": "const config = require('./config.js'); module.exports = (value) => config.prefix + String(value);\n" },
    "api-contract": { "src/api.js": "module.exports = function list(values, limit) { const result = values.slice(); return Number.isInteger(limit) && limit > 0 ? result.slice(0, limit) : result; };\n" },
    "preserve-refactor": { "src/total.js": "const total = (values) => values.reduce((sum, value) => sum + value, 0);\nmodule.exports = total;\n" },
    "docs-sync": { "README.md": "# Number parser\n\nThe `parseNumber` function converts text to a number.\n\n## Example\n`parseNumber('42')` returns `42`.\n" },
    "scope-guard": { "src/safe.js": "function safeName(value) { return typeof value === 'string' ? value : ''; }\nmodule.exports = { safeName };\n" },
    "dag-order": { "src/pipeline.js": "const normalize = require('./normalize.js'); const sort = require('./sort.js'); module.exports = (values) => sort(normalize(values));\n" },
    "recovery-cleanup": { "src/recover.js": "const fs = require('node:fs'); function recover(journal, temporary) { const value = fs.readFileSync(journal, 'utf8'); fs.unlinkSync(temporary); return value; } module.exports = { recover };\n" }
  };
  for (const [relative, content] of Object.entries(replacements[taskId] ?? {})) writeFileSync(join(base, relative), content, "utf8");
}
