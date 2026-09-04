#!/usr/bin/env node
import { createHash, generateKeyPairSync } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = resolve(fileURLToPath(new URL(".", import.meta.url)));
const bundleRoot = resolve(here, "../../..");
const moduleRoot = join(bundleRoot, "modules", "ai-code-benchmark");
const experimentId = option("--experiment-id") ?? "bench-09-pilot-codex";
if (!/^[a-z][a-z0-9-]{2,63}$/u.test(experimentId)) throw new Error("--experiment-id is invalid.");
const localRoot = join(here, ".local", experimentId);
const repositoryPath = join(localRoot, "repository");
// Runtime and worker worktrees add several deterministic ID segments. Keep the
// external state root short so those nested Git paths stay below Win32 tool
// limits even when the experiment ID uses its full immutable name.
const shortStateId = createHash("sha256").update(experimentId, "utf8").digest("hex").slice(0, 12);
const stateRoot = resolve(option("--state-root") ?? join(process.env.LOCALAPPDATA ?? tmpdir(), "iab", shortStateId));
const configPath = join(localRoot, "config.json");
const experimentPath = join(localRoot, "experiment.json");
const authorizationPath = join(localRoot, "authorization.json");
const rootCli = join(bundleRoot, "dist", "src", "cli.js");
const controlDll = join(bundleRoot, "modules", "ai-code-control", "tools", "ai-code-control", "src", "AiCodeControl.Cli", "bin", "Release", "net9.0", "AiCodeControl.Cli.dll");
const codexExecutable = option("--codex-executable") ?? process.env.BENCH09_CODEX_EXECUTABLE ?? "codex";
// The elevated native Windows sandbox fails to launch child commands on this
// host (CreateProcessWithLogonW error 2). Keep workspace-write isolation, but
// use Codex's documented unelevated Windows implementation for all pilot arms.
const codexCommand = process.platform === "win32"
  ? [codexExecutable, "--config", 'windows.sandbox="unelevated"']
  : [codexExecutable];

mkdirSync(repositoryPath, { recursive: true });
mkdirSync(join(stateRoot, ".."), { recursive: true });
mkdirSync(stateRoot, { recursive: true });

const tasks = await import(pathToFileURL(join(moduleRoot, "dist", "src", "pilot", "tasks.js")).href);
const pilot = await import(pathToFileURL(join(moduleRoot, "dist", "src", "pilot", "driver.js")).href);
const preregistration = await import(pathToFileURL(join(moduleRoot, "dist", "src", "pilot", "preregistration.js")).href);
const authorization = await import(pathToFileURL(join(moduleRoot, "dist", "src", "pilot", "authorization.js")).href);

const config = {
  schemaVersion: "1.0",
  stateRoot,
  commands: {
    codex: codexCommand,
    claude: ["claude"],
    infoapex: [process.execPath, rootCli],
    aiCodeControl: ["dotnet", controlDll]
  },
  capabilities: {
    liveExecution: true,
    networkExpansion: false,
    publish: false,
    secretForwarding: false
  },
  pilot: {
    schemaVersion: "bench-09-live.v1",
    trustedFixtureOnly: true,
    maximumInvocations: 30,
    equalBudgets: true,
    sharedConfigHash: tasks.pilotSharedConfigHash(),
    arms: {
      "orchestrated-no-icm": { contextProvider: "none", contextPackageMode: "off" },
      "full-icm": { contextProvider: "ai-code-control", contextPackageMode: "enforce" }
    }
  }
};
writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");

const preflight = await pilot.pilotPreflight({ suiteRoot: here, repositoryPath, stateRoot, configPath, experimentId, fake: false });
if (!preflight.ok) {
  console.log(JSON.stringify({ status: "BLOCKED", phase: "preflight", errors: preflight.errors, checks: preflight.checks }, null, 2));
  process.exit(3);
}
preregistration.writePilotExperiment(preflight.experiment, experimentPath);

const { privateKey, publicKey } = generateKeyPairSync("ed25519", {
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" }
});
const issuedAt = new Date();
const payload = {
  experimentId: String(preflight.experiment.id),
  experimentHash: String(preflight.experiment.experimentHash),
  provider: "codex",
  maximumInvocations: 30,
  scope: "BENCH-09",
  approvedBy: "explicit-user-request-2026-09-04",
  issuedAt: issuedAt.toISOString(),
  expiresAt: new Date(issuedAt.getTime() + 4 * 60 * 60 * 1000).toISOString()
};
const signed = authorization.signPilotAuthorization(payload, privateKey, publicKey);
writeFileSync(authorizationPath, `${JSON.stringify(signed, null, 2)}\n`, "utf8");

console.log(JSON.stringify({
  status: "PASS",
  configPath,
  experimentPath,
  authorizationPath,
  stateRoot,
  repositoryPath,
  experimentId: preflight.experiment.id,
  experimentHash: preflight.experiment.experimentHash,
  checks: preflight.checks
}, null, 2));

function option(name) { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] ?? null : null; }
