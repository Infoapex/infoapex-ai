#!/usr/bin/env node
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { initConfig, loadConfig } from "./config.js";
import { schemaRegistry } from "./schema-registry.js";
import { loadSuite } from "./dataset.js";
import { freezeSuiteToFile } from "./experiment.js";
import { doctorConfiguredAdapters } from "./adapters/index.js";
import { resumeExperiment, runExperiment } from "./runtime/index.js";
import { evaluateExperiment } from "./evaluation/index.js";
import { readFileSync } from "node:fs";
import { buildBenchmarkReport, compareExperimentStates, renderMarkdownReport, reportFromState } from "./report.js";
import { benchmarkReportExitCode } from "./exit-code.js";
import type { CommandResult } from "./types.js";

const args = process.argv.slice(2);
const command = args[0];

try {
  if (!command || command === "--help" || command === "-h" || command === "help") {
    printHelp();
  } else if (command === "init") {
    const repositoryPath = repository();
    const result = initConfig(repositoryPath, args.includes("--force"));
    output({ status: "DONE", command, details: result });
  } else if (command === "doctor") {
    const config = loadConfig(repository());
    const adapters = await doctorConfiguredAdapters(config);
    output({ status: "DONE", command, details: { node: process.version, stateRootConfigured: config.stateRoot !== null, registeredSchemas: schemaRegistry.names(), liveExecution: config.capabilities.liveExecution, adapters } });
  } else if (command === "validate") {
    const suite = loadSuite(requiredOption("--suite"));
    output({ status: "DONE", command, details: { suiteId: suite.value.id, suiteHash: suite.hash, taskCount: suite.tasks.length } });
  } else if (command === "freeze") {
    const suite = loadSuite(requiredOption("--suite"));
    const environment = { schemaVersion: "1.0", id: `local-${process.platform}-${process.arch}`, os: process.platform, architecture: process.arch, toolchain: { node: process.version }, hardware: null, cliVersions: {}, modulePins: {}, redactedConfiguration: {} };
    const experiment = freezeSuiteToFile(suite, environment, requiredOption("--out"));
    output({ status: "DONE", command, details: { id: experiment.id, experimentHash: experiment.experimentHash } });
  } else if (command === "run") {
    if (args.includes("--live")) unsupported(command, "Live execution requires the separately signed BENCH-P pilot driver; the generic CLI never enables it implicitly.");
    else {
      const mode = option("--mode") ?? "deterministic";
      if (mode !== "deterministic") throw new Error("The generic CLI supports only --mode deterministic.");
      const repo = repository();
      const result = await runExperiment({ experiment: requiredOption("--experiment"), repositoryPath: repo, stateRoot: configuredStateRoot(repo), concurrency: positiveIntegerOption("--concurrency") ?? 1, timeoutMs: positiveIntegerOption("--timeout-ms") ?? 30_000 });
      output({ status: "DONE", command, details: { ...result } });
    }
  } else if (command === "resume") {
    if (args.includes("--live")) unsupported(command, "Live execution requires the separately signed BENCH-P pilot driver; the generic CLI never enables it implicitly.");
    else {
      const repo = repository();
      const result = await resumeExperiment({ experimentId: requiredOption("--experiment-id"), stateRoot: configuredStateRoot(repo), concurrency: positiveIntegerOption("--concurrency") ?? 1, timeoutMs: positiveIntegerOption("--timeout-ms") ?? 30_000 });
      output({ status: "DONE", command, details: { ...result } });
    }
  } else if (command === "evaluate") {
    const repo = repository();
    const stateRoot = configuredStateRoot(repo);
    const suitePath = option("--suite") ?? resolve("datasets", "generic-v1", "suite.json");
    if (!existsSync(suitePath)) throw new Error("Evaluation requires --suite <suite.json> when the generic suite is not present.");
    const suite = loadSuite(suitePath);
    const result = await evaluateExperiment({ stateRoot, experimentId: requiredOption("--experiment-id"), suite });
    output({ status: "DONE", command, details: result });
  } else if (command === "report") {
    const repo = repository(); const stateRoot = configuredStateRoot(repo); const format = option("--format") ?? "json";
    if (format !== "json" && format !== "markdown") throw new Error("--format must be json or markdown.");
    const hypothesis = option("--hypothesis"); const report = reportFromState(stateRoot, requiredOption("--experiment-id"), { candidateHypothesis: hypothesis ? JSON.parse(readFileSync(resolve(hypothesis), "utf8")) as Record<string, unknown> : null, generatedAt: option("--generated-at") ?? undefined });
    if (format === "markdown") console.log(renderMarkdownReport(report)); else output({ status: "DONE", command, details: report as unknown as Record<string, unknown> });
    process.exitCode = benchmarkReportExitCode(report);
  } else if (command === "compare") {
    const repo = repository(); const stateRoot = configuredStateRoot(repo); const format = option("--format") ?? "json";
    if (format !== "json" && format !== "markdown") throw new Error("--format must be json or markdown.");
    const hypothesis = option("--hypothesis"); const report = compareExperimentStates(stateRoot, requiredOption("--baseline"), requiredOption("--candidate"), { candidateHypothesis: hypothesis ? JSON.parse(readFileSync(resolve(hypothesis), "utf8")) as Record<string, unknown> : null, generatedAt: option("--generated-at") ?? undefined });
    if (format === "markdown") console.log(renderMarkdownReport(report)); else output({ status: "DONE", command, details: report as unknown as Record<string, unknown> });
    process.exitCode = benchmarkReportExitCode(report);
  } else {
    throw new Error(`Unknown command: ${command}`);
  }
} catch (error) {
  output({ status: "BLOCKED", command: command ?? "help", message: error instanceof Error ? error.message : String(error) });
  process.exitCode = 2;
}

function repository(): string {
  const value = option("--repo");
  return resolve(value ?? process.cwd());
}

function option(name: string): string | null {
  const index = args.indexOf(name);
  if (index < 0) return null;
  const value = args[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`Missing value for ${name}`);
  return value;
}

function requiredOption(name: string): string {
  const value = option(name);
  if (!value) throw new Error(`Missing value for ${name}`);
  return value;
}

function positiveIntegerOption(name: string): number | null {
  const value = option(name);
  if (value === null) return null;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) throw new Error(`${name} must be a positive integer.`);
  return parsed;
}

function configuredStateRoot(repositoryPath: string): string {
  const explicit = option("--state-root");
  if (explicit) return resolve(explicit);
  const configured = loadConfig(repositoryPath).stateRoot;
  if (!configured) throw new Error("A state root is required via --state-root or repository configuration.");
  return resolve(repositoryPath, configured);
}

function unsupported(commandName: string, message = `${commandName} requires a later BENCH runtime milestone; no execution was attempted.`): void {
  output({ status: "UNSUPPORTED", command: commandName, message });
  process.exitCode = 3;
}

function output(result: CommandResult): void {
  console.log(JSON.stringify(result, null, 2));
}

function printHelp(): void {
  console.log(`ai-code-benchmark — independent AI coding benchmark\n\nUsage:\n  ai-code-benchmark init --repo <path> [--force]\n  ai-code-benchmark doctor --repo <path>\n  ai-code-benchmark validate --suite <suite.json>\n  ai-code-benchmark freeze --suite <suite.json> --out <experiment.json>\n  ai-code-benchmark run --experiment <experiment.json> --mode deterministic --state-root <path> [--repo <path>] [--concurrency <n>]\n  ai-code-benchmark run --experiment <experiment.json> --live --authorization <file>\n  ai-code-benchmark resume --experiment-id <id> --state-root <path> [--concurrency <n>]\n  ai-code-benchmark evaluate --experiment-id <id>\n  ai-code-benchmark report --experiment-id <id> --format json|markdown\n  ai-code-benchmark compare --baseline <id> --candidate <id>\n\nDeterministic run/resume are available through this generic CLI. Live BENCH-P execution remains behind its dedicated signed-authorization driver.\nExit codes: 0 valid command; 2 invalid input/config; 3 unavailable or blocked infrastructure; 4 reject; 5 inconclusive; 6 policy/security violation.`);
}
