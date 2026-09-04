#!/usr/bin/env node

/*
 * BENCH-D provider stand-in.  It deliberately communicates only through stdin
 * and stdout; the harness invokes it with shell:false and a fixed argv.  The
 * output is intentionally boring so every observation has a stable payload.
 */
import { setTimeout as delay } from "node:timers/promises";

const mode = process.argv[2] ?? "run";
if (mode === "probe") {
  process.stdout.write(JSON.stringify({ schemaVersion: "bench-d-fake.v1", capabilities: ["structured-output", "bounded-exec"] }));
  process.exit(0);
}

let request;
try {
  request = JSON.parse(await readStdin());
} catch {
  process.stderr.write("invalid request\n");
  process.exit(64);
}

if (request.scenario === "timeout") await delay(250);
if (request.scenario === "truncated") {
  process.stdout.write("X".repeat(200_000));
  process.exit(0);
}
if (request.scenario === "quota" || request.scenario === "unsupported") {
  process.stdout.write(JSON.stringify({ status: "UNSUPPORTED", reason: request.scenario === "quota" ? "QUOTA_EXHAUSTED" : "CAPABILITY_UNAVAILABLE" }));
  process.exit(75);
}
if (request.scenario === "failure") {
  process.stdout.write(JSON.stringify({ status: "FAILED", reason: "FAKE_FAILURE" }));
  process.exit(1);
}

const changedPaths = request.scenario === "scope" ? ["secrets/token.txt"] : request.scenario === "false-done" ? [] : ["src/result.txt"];
const deliberatelyWrong = request.arm === "A" && ["api-contract", "cross-file-config"].includes(request.taskId)
  || request.arm === "B" && request.taskId === "api-contract";
process.stdout.write(JSON.stringify({
  schemaVersion: "bench-d-fake.v1",
  status: "DONE",
  taskId: request.taskId,
  arm: request.arm,
  seed: request.seed,
  changedPaths,
  content: deliberatelyWrong ? "WRONG\n" : "PASS\n"
}));

function readStdin() {
  return new Promise((resolve) => {
    let text = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => { text += chunk; });
    process.stdin.on("end", () => resolve(text));
  });
}
