#!/usr/bin/env node
import { createHash, generateKeyPairSync } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = resolve(fileURLToPath(new URL(".", import.meta.url)));
const bundleRoot = resolve(here, "../../../..");
const moduleRoot = join(bundleRoot, "modules", "ai-code-benchmark");
const suiteRoot = join(bundleRoot, "validation", "benchmark", "pilot");
const experimentId = option("--experiment-id") ?? "p5-otel-candidate-r1-20260904";
if (!/^[a-z][a-z0-9-]{2,63}$/u.test(experimentId)) throw new Error("--experiment-id is invalid.");
const localRoot = join(here, ".local", experimentId);
const repositoryPath = join(localRoot, "repository");
const shortStateId = createHash("sha256").update(experimentId, "utf8").digest("hex").slice(0, 12);
const stateRoot = resolve(option("--state-root") ?? join(process.env.LOCALAPPDATA ?? tmpdir(), "iab", shortStateId));
const configPath = join(localRoot, "config.json");
const experimentPath = join(localRoot, "experiment.json");
const authorizationPath = join(localRoot, "authorization.json");
const hypothesisPath = join(here, "candidate-hypothesis.json");
const baselinePath = join(bundleRoot, "validation", "benchmark", "P5-BASELINE.v2.json");
const rootCli = join(bundleRoot, "dist", "src", "cli.js");
const controlDll = join(bundleRoot, "modules", "ai-code-control", "tools", "ai-code-control", "src", "AiCodeControl.Cli", "bin", "Release", "net9.0", "AiCodeControl.Cli.dll");
const codexExecutable = option("--codex-executable") ?? process.env.BENCH09_CODEX_EXECUTABLE ?? "codex";
const codexCommand = process.platform === "win32" ? [codexExecutable, "--config", 'windows.sandbox="unelevated"'] : [codexExecutable];

mkdirSync(repositoryPath, { recursive: true }); mkdirSync(stateRoot, { recursive: true });
const candidate = await import(pathToFileURL(join(moduleRoot, "dist", "src", "p5", "otel-candidate.js")).href);
const authorization = await import(pathToFileURL(join(moduleRoot, "dist", "src", "p5", "authorization.js")).href);
const pilot = await import(pathToFileURL(join(moduleRoot, "dist", "src", "pilot", "driver.js")).href);
const canonical = await import(pathToFileURL(join(moduleRoot, "dist", "src", "canonical-json.js")).href);

const config = {
  schemaVersion: "1.0", stateRoot,
  commands: { codex: codexCommand, claude: ["claude"], infoapex: [process.execPath, rootCli], aiCodeControl: ["dotnet", controlDll] },
  capabilities: { liveExecution: true, networkExpansion: false, publish: false, secretForwarding: false },
  pilot: {
    schemaVersion: "bench-09-live.v1", trustedFixtureOnly: true, maximumInvocations: 30, equalBudgets: true,
    sharedConfigHash: (await import(pathToFileURL(join(moduleRoot, "dist", "src", "pilot", "tasks.js")).href)).pilotSharedConfigHash(),
    arms: { "orchestrated-no-icm": { contextProvider: "none", contextPackageMode: "off" }, "full-icm": { contextProvider: "ai-code-control", contextPackageMode: "enforce" } }
  }
};
writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
const preflight = await pilot.pilotPreflight({ suiteRoot, repositoryPath, stateRoot, configPath, experimentId: `${experimentId}-preflight`, fake: false });
if (!preflight.ok) { console.log(JSON.stringify({ status: "BLOCKED", phase: "preflight", errors: preflight.errors, checks: preflight.checks }, null, 2)); process.exit(3); }

const hypothesis = JSON.parse(readFileSync(hypothesisPath, "utf8"));
const baseline = JSON.parse(readFileSync(baselinePath, "utf8"));
const environment = { schemaVersion: "1.0", id: `p5-otel-${process.platform}-${process.arch}`, os: process.platform, architecture: process.arch, toolchain: { node: process.version }, hardware: null, cliVersions: {}, modulePins: {}, redactedConfiguration: { provider: "codex", model: "gpt-5.6-luna", effort: "medium", treatment: "INFOAPEX_OTEL_ENABLED off/on", isolation: "trusted-generated-fixtures-only", windowsSandboxImplementation: process.platform === "win32" ? "unelevated" : null } };
const experiment = candidate.createOtelCandidateExperiment({ suiteRoot, hypothesis, environment, experimentId, baselineExperimentHash: baseline.baselineExperiment.experimentHash });
writeFileSync(experimentPath, `${JSON.stringify(experiment, null, 2)}\n`, "utf8");

const { privateKey, publicKey } = generateKeyPairSync("ed25519", { privateKeyEncoding: { type: "pkcs8", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } });
const issuedAt = new Date(); const hypothesisHash = canonical.sha256CanonicalJson(hypothesis);
const payload = { experimentId, experimentHash: experiment.experimentHash, hypothesisHash, provider: "codex", maximumInvocations: 20, scope: "P5-OTEL", approvedBy: "explicit-user-request-2026-09-04", issuedAt: issuedAt.toISOString(), expiresAt: new Date(issuedAt.getTime() + 4 * 60 * 60 * 1000).toISOString() };
const signed = authorization.signOtelCandidateAuthorization(payload, privateKey, publicKey);
writeFileSync(authorizationPath, `${JSON.stringify(signed, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
authorization.validateOtelCandidateAuthorization(authorizationPath, { experimentId, experimentHash: experiment.experimentHash, hypothesisHash });
console.log(JSON.stringify({ status: "PASS", experimentId, experimentHash: experiment.experimentHash, protocolHash: experiment.protocolHash, hypothesisHash, experimentPath, authorizationPath, configPath, stateRoot, repositoryPath, checks: preflight.checks }, null, 2));

function option(name) { const index = process.argv.indexOf(name); return index >= 0 ? process.argv[index + 1] ?? null : null; }
