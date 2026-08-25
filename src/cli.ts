#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";

const args = process.argv.slice(2);
const command = args[0];

if (command === "init") {
  const repo = resolve(option("--repo") ?? process.cwd());
  const mode = option("--mode") ?? "independent";
  if (mode !== "independent" && mode !== "integrated") {
    fail("--mode must be independent or integrated");
  }
  const apexRoot = join(repo, ".infoapex-ai");
  const handoffRoot = join(apexRoot, "runs");
  mkdirSync(handoffRoot, { recursive: true });
  const config = {
    schemaVersion: "1.0",
    mode,
    handoffRoot: relativePath(repo, handoffRoot),
    planner: { enabled: mode === "integrated" },
    worker: { enabled: mode === "integrated" }
  };
  writeJson(join(apexRoot, "config.json"), config);
  writeText(join(apexRoot, "README.md"), "# infoapex-ai integration\n\nMode: " + mode + "\n\nManaged by infoapex-ai init. The modules remain independently runnable.\n");
  console.log(JSON.stringify({ status: "DONE", mode, configPath: join(apexRoot, "config.json"), handoffRoot }, null, 2));
  process.exitCode = 0;
} else if (command === "status") {
  const repo = resolve(option("--repo") ?? process.cwd());
  const path = join(repo, ".infoapex-ai", "config.json");
  if (!existsSync(path)) {
    console.log(JSON.stringify({ status: "INDEPENDENT", configured: false }, null, 2));
    process.exitCode = 0;
  } else {
    console.log(JSON.stringify({ status: "DONE", configured: true, config: JSON.parse(readFileSync(path, "utf8")) }, null, 2));
  }
} else if (command === "handoff") {
  const repo = resolve(option("--repo") ?? process.cwd());
  const direction = option("--direction");
  const runId = option("--run-id");
  const payloadPath = option("--payload");
  if ((direction !== "planner-to-worker" && direction !== "worker-to-planner") || !runId || !payloadPath) {
    fail("Usage: infoapex-ai handoff --direction <planner-to-worker|worker-to-planner> --run-id <id> --payload <json>");
  }
  const config = readConfig(repo);
  if (config.mode !== "integrated") {
    fail("Integration is disabled. Run infoapex-ai init --mode integrated first.");
  }
  const payload = JSON.parse(readFileSync(resolve(repo, payloadPath!), "utf8"));
  const handoff = {
    schemaVersion: "1.0",
    handoffId: randomUUID(),
    direction,
    createdAt: new Date().toISOString(),
    runId,
    payload
  };
  const output = join(repo, config.handoffRoot, runId!, `${direction}.json`);
  writeJson(output, handoff);
  console.log(JSON.stringify({ status: "DONE", output }, null, 2));
} else {
  console.error("Usage: infoapex-ai <init|status|handoff>");
  process.exitCode = 1;
}

function option(name: string): string | null {
  const index = args.indexOf(name);
  return index < 0 ? null : args[index + 1] ?? null;
}

function readConfig(repo: string): { mode: "independent" | "integrated"; handoffRoot: string } {
  const path = join(repo, ".infoapex-ai", "config.json");
  if (!existsSync(path)) {
    fail("infoapex-ai is not initialized for this repository");
  }
  return JSON.parse(readFileSync(path, "utf8")) as { mode: "independent" | "integrated"; handoffRoot: string };
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
  const value = resolve(to).replace(resolve(from), "").replaceAll("\\", "/");
  return value.startsWith("/") ? value.slice(1) : value;
}

function fail(message: string): never {
  console.error(JSON.stringify({ status: "BLOCKED", error: message }));
  process.exit(1);
}
