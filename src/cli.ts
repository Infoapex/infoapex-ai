#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import {
  assertHandoffEnvelope,
  assertPayload,
  assertSafeRunId,
  parseJsonFile,
  readIntegrationConfig,
  resolveHandoffFileForWrite,
  resolveHandoffRootForWrite,
  resolveIntegrationConfigForRead,
  resolveIntegrationReadmeForWrite,
  resolveIntegrationRootForWrite,
  writeJsonCreateNew
} from "./integration/handoff-security.js";

const args = process.argv.slice(2);
const command = args[0];

try {
if (command === "init") {
  const repo = resolve(option("--repo") ?? process.cwd());
  const mode = option("--mode") ?? "independent";
  if (mode !== "independent" && mode !== "integrated") {
    fail("--mode must be independent or integrated");
  }
  resolveIntegrationRootForWrite(repo);
  const handoffRoot = resolveHandoffRootForWrite(repo, ".infoapex-ai/runs");
  const configPath = resolveIntegrationConfigForRead(repo);
  const readmePath = resolveIntegrationReadmeForWrite(repo);
  const config = {
    schemaVersion: "1.0",
    mode,
    handoffRoot: relativePath(repo, handoffRoot),
    planner: { enabled: mode === "integrated" },
    worker: { enabled: mode === "integrated" }
  };
  writeJson(configPath, config);
  writeText(readmePath, "# infoapex-ai integration\n\nMode: " + mode + "\n\nManaged by infoapex-ai init. The modules remain independently runnable.\n");
  console.log(JSON.stringify({ status: "DONE", mode, configPath, handoffRoot }, null, 2));
  process.exitCode = 0;
} else if (command === "status") {
  const repo = resolve(option("--repo") ?? process.cwd());
  const path = resolveIntegrationConfigForRead(repo);
  if (!existsSync(path)) {
    console.log(JSON.stringify({ status: "INDEPENDENT", configured: false }, null, 2));
    process.exitCode = 0;
  } else {
    console.log(JSON.stringify({ status: "DONE", configured: true, config: readIntegrationConfig(repo) }, null, 2));
  }
} else if (command === "handoff") {
  const repo = resolve(option("--repo") ?? process.cwd());
  const direction = option("--direction");
  const runId = option("--run-id");
  const payloadPath = option("--payload");
  if ((direction !== "planner-to-worker" && direction !== "worker-to-planner") || !runId || !payloadPath) {
    fail("Usage: infoapex-ai handoff --direction <planner-to-worker|worker-to-planner> --run-id <id> --payload <json>");
  }
  // Validate the untrusted path segment before reading config or payload files.
  assertSafeRunId(runId);
  const config = readIntegrationConfig(repo);
  if (config.mode !== "integrated") {
    fail("Integration is disabled. Run infoapex-ai init --mode integrated first.");
  }
  const payload = parseJsonFile(resolve(repo, payloadPath), "handoff payload");
  assertPayload(payload);
  const handoff = {
    schemaVersion: "1.0",
    handoffId: randomUUID(),
    direction,
    createdAt: new Date().toISOString(),
    runId,
    payload
  };
  assertHandoffEnvelope(handoff);
  const output = resolveHandoffFileForWrite(repo, config.handoffRoot, runId, `${direction}.json`);
  writeJsonCreateNew(output, handoff);
  console.log(JSON.stringify({ status: "DONE", output }, null, 2));
} else {
  console.error("Usage: infoapex-ai <init|status|handoff>");
  process.exitCode = 1;
}
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}

function option(name: string): string | null {
  const index = args.indexOf(name);
  return index < 0 ? null : args[index + 1] ?? null;
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function writeText(path: string, value: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, value, "utf8");
}

function relativePath(from: string, to: string): string {
  return relative(resolve(from), resolve(to)).replaceAll("\\", "/");
}

function fail(message: string): never {
  console.error(JSON.stringify({ status: "BLOCKED", error: message }));
  process.exit(1);
}
