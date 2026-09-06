import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";

const cliPath = resolve("dist/src/cli.js");

function runCli(repositoryPath: string, args: string[]): { status: number; stdout: string; stderr: string } {
  try {
    const stdout = execFileSync(process.execPath, [cliPath, ...args], {
      cwd: repositoryPath,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"]
    });
    return { status: 0, stdout, stderr: "" };
  } catch (error) {
    const result = error as { status?: number; stdout?: string; stderr?: string };
    return { status: result.status ?? 1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
  }
}

test("installer keeps independent mode isolated and exposes status", () => {
  const repository = mkdtempSync(join(tmpdir(), "apex-cli-independent-"));
  try {
    const init = runCli(repository, ["init", "--repo", repository, "--mode", "independent"]);
    assert.equal(init.status, 0, init.stderr);
    const initBody = JSON.parse(init.stdout) as { mode: string; configPath: string; handoffRoot: string };
    assert.equal(initBody.mode, "independent");
    assert.match(initBody.configPath, /[\\/]\.infoapex-ai[\\/]config\.json$/);
    assert.match(initBody.handoffRoot, /[\\/]\.infoapex-ai[\\/]runs$/);
    assert.equal(existsSync(join(repository, ".infoapex-ai", "README.md")), true);
    assert.match(readFileSync(join(repository, ".infoapex-ai", "README.md"), "utf8"), /infoapex-ai init/);

    const status = runCli(repository, ["status", "--repo", repository]);
    const statusBody = JSON.parse(status.stdout) as {
      configured: boolean;
      config: { mode: string; planner: { enabled: boolean } };
      modules: readonly { name: string; sourceCommit: string | null; sourceRepository: string; provenanceStatus?: string; publicationGate?: string }[];
    };
    assert.equal(status.status, 0);
    assert.equal(statusBody.configured, true);
    assert.equal(statusBody.config.mode, "independent");
    assert.equal(statusBody.config.planner.enabled, false);
    // P3 exit gate: "toate modulele raportează versiunile fixate" - status reports the
    // pinned upstream commit for every vendored module from modules/provenance.json.
    assert.ok(statusBody.modules.length >= 6, JSON.stringify(statusBody.modules));
    const worker = statusBody.modules.find((entry) => entry.name === "ai-code-worker");
    assert.ok(worker);
    assert.ok(worker!.sourceCommit);
    assert.match(worker!.sourceCommit, /^[a-f0-9]{40}$/);
    assert.match(worker!.sourceRepository, /^https:\/\//);
    const benchmark = statusBody.modules.find((entry) => entry.name === "ai-code-benchmark");
    assert.ok(benchmark);
    assert.match(benchmark!.sourceCommit ?? "", /^[a-f0-9]{40}$/u);
    assert.equal(benchmark!.provenanceStatus, "published");
    assert.equal(benchmark!.publicationGate, undefined);

    const payloadPath = join(repository, "payload.json");
    writeFileSync(payloadPath, JSON.stringify({ status: "DONE" }), "utf8");
    const handoff = runCli(repository, [
      "handoff", "--repo", repository, "--direction", "planner-to-worker",
      "--run-id", "independent-run", "--payload", payloadPath
    ]);
    assert.notEqual(handoff.status, 0);
    assert.match(handoff.stderr, /Integration is disabled/);
  } finally {
    rmSync(repository, { recursive: true, force: true });
  }
});

test("installer enables versioned bidirectional handoff in integrated mode", () => {
  const repository = mkdtempSync(join(tmpdir(), "apex-cli-integrated-"));
  try {
    const init = runCli(repository, ["init", "--repo", repository, "--mode", "integrated"]);
    assert.equal(init.status, 0, init.stderr);

    const payloadPath = join(repository, "payload.json");
    writeFileSync(payloadPath, JSON.stringify({ status: "DONE", taskId: "T-01" }), "utf8");
    for (const direction of ["planner-to-worker", "worker-to-planner"]) {
      const handoff = runCli(repository, [
        "handoff", "--repo", repository, "--direction", direction,
        "--run-id", "integrated-run", "--payload", payloadPath
      ]);
      assert.equal(handoff.status, 0, handoff.stderr);
      const output = JSON.parse(handoff.stdout).output as string;
      const envelope = JSON.parse(readFileSync(output, "utf8")) as {
        schemaVersion: string;
        direction: string;
        runId: string;
        payload: { status: string };
      };
      assert.equal(envelope.schemaVersion, "1.0");
      assert.equal(envelope.direction, direction);
      assert.equal(envelope.runId, "integrated-run");
      assert.equal(envelope.payload.status, "DONE");
    }
  } finally {
    rmSync(repository, { recursive: true, force: true });
  }
});

test("installer rejects an unknown mode with a structured blocked result", () => {
  const repository = mkdtempSync(join(tmpdir(), "apex-cli-invalid-"));
  try {
    const result = runCli(repository, ["init", "--repo", repository, "--mode", "unknown"]);
    assert.notEqual(result.status, 0);
    assert.equal(JSON.parse(result.stderr).status, "BLOCKED");
  } finally {
    rmSync(repository, { recursive: true, force: true });
  }
});

test("full installer creates a reusable .NET/Next.js profile without module-relative paths", () => {
  const repository = mkdtempSync(join(tmpdir(), "apex-cli-full-profile-"));
  try {
    mkdirSync(join(repository, "server", "Product.Api"), { recursive: true });
    mkdirSync(join(repository, "server", "Product.Api.Tests"), { recursive: true });
    mkdirSync(join(repository, "client"), { recursive: true });
    mkdirSync(join(repository, "data"), { recursive: true });
    writeFileSync(join(repository, "server", "Product.Api", "Product.Api.csproj"), '<Project Sdk="Microsoft.NET.Sdk.Web" />');
    writeFileSync(join(repository, "server", "Product.Api.Tests", "Product.Api.Tests.csproj"), '<Project Sdk="Microsoft.NET.Sdk" />');
    writeFileSync(join(repository, "client", "package.json"), JSON.stringify({ scripts: { build: "next build", typecheck: "tsc --noEmit" } }));
    const init = runCli(repository, ["init", "--repo", repository, "--mode", "integrated", "--full", "--profile", "dotnet-nextjs", "--backend-dir", "server", "--frontend-dir", "client", "--ml-dir", "data"]);
    assert.equal(init.status, 0, init.stderr);
    const body = JSON.parse(init.stdout) as { status: string; profile: string; created: readonly string[] };
    assert.equal(body.status, "DONE");
    assert.equal(body.profile, "dotnet-nextjs");
    assert.ok(body.created.includes("TODO.md"));
    assert.equal(existsSync(join(repository, "AGENTS.md")), true);
    assert.equal(existsSync(join(repository, "CLAUDE.md")), true);
    assert.equal(existsSync(join(repository, ".ai-code-control", "memory", "PROJECT-STATE.md")), true);

    const worker = JSON.parse(readFileSync(join(repository, ".ai-code-worker", "config.json"), "utf8")) as {
      contextProvider: string;
      adapters: { codex: { model: string; reasoningEffort: string }; aiCodeControl: { baseArgs: readonly string[] } };
    };
    assert.equal(worker.contextProvider, "ai-code-control");
    assert.equal(worker.adapters.codex.model, "gpt-5.6");
    assert.equal(worker.adapters.codex.reasoningEffort, "high");
    assert.match(worker.adapters.aiCodeControl.baseArgs.join(" "), /AiCodeControl\.Cli/);

    const control = JSON.parse(readFileSync(join(repository, ".ai-code-control", "config", "code-control.json"), "utf8")) as { toolchains: readonly { path: string; enabled: boolean; commands: readonly { name: string; run: string }[] }[] };
    assert.deepEqual(control.toolchains.map((toolchain) => toolchain.path), ["server", "client", "data"]);
    assert.deepEqual(control.toolchains[1]?.commands.map((command) => command.name), ["typecheck", "build"]);
    assert.equal(control.toolchains[1]?.commands.some((command) => command.run.includes("npm test") || command.run.includes("npm run lint")), false);
    assert.equal(control.toolchains[0]?.commands.some((command) => command.run.includes("Product.Api.Tests/Product.Api.Tests.csproj")), true);
    assert.equal(control.toolchains[2]?.enabled, false);
    const review = JSON.parse(readFileSync(join(repository, ".ai-code-review", "config.json"), "utf8")) as { worker: readonly string[] };
    assert.match(review.worker[1] ?? "", /modules[\\/]ai-code-worker[\\/]dist[\\/]src[\\/]cli\.js$/);
    const mcp = JSON.parse(readFileSync(join(repository, ".mcp.json"), "utf8")) as { mcpServers: { "ai-code-control": { args: readonly string[]; env: Record<string, string> } } };
    assert.match(mcp.mcpServers["ai-code-control"].args[0] ?? "", /mcp-server[\\/]dist[\\/]server\.js$/);
    assert.equal(mcp.mcpServers["ai-code-control"].env.REPO_ROOT, repository);
    assert.equal(existsSync(join(repository, ".claude", "settings.json")), true);
    assert.match(readFileSync(join(repository, ".codex", "config.toml"), "utf8"), /\[mcp_servers\.ai-code-control\]/);
    assert.match(readFileSync(join(repository, ".gitignore"), "utf8"), /\.infoapex-ai\/runs\//);
  } finally {
    rmSync(repository, { recursive: true, force: true });
  }
});
