import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { AiCodeControlCliProvider } from "../../src/context-provider/ai-code-control-cli.js";
import { NoneContextProvider } from "../../src/context-provider/none-provider.js";
import { resolveContextProvider } from "../../src/context-provider/resolve.js";
import type { ProjectConfig } from "../../src/config/project-config.js";

const tempRoots: string[] = [];

after(() => {
  for (const root of tempRoots) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("NoneContextProvider", () => {
  it("resolves UNAVAILABLE for every method without throwing", async () => {
    const provider = new NoneContextProvider();

    assert.equal(provider.kind, "none");
    assert.deepEqual(await provider.health(), { status: "UNAVAILABLE", reason: 'contextProvider is "none"' });
    assert.equal((await provider.brief("task")).status, "UNAVAILABLE");
    assert.equal((await provider.findSymbol("Foo")).status, "UNAVAILABLE");
    assert.equal((await provider.impact("Foo")).status, "UNAVAILABLE");
    assert.equal((await provider.compileContext({ manifestPath: "manifest.json", manifestSha256: "a".repeat(64), taskId: "T1", maximumTokens: 1000 })).status, "UNAVAILABLE");
    assert.equal((await provider.refresh()).status, "UNAVAILABLE");
  });
});

describe("resolveContextProvider", () => {
  it("defaults to NoneContextProvider when config is null", () => {
    const provider = resolveContextProvider(null, { repositoryRoot: process.cwd() });
    assert.equal(provider.kind, "none");
  });

  it("defaults to NoneContextProvider when contextProvider is absent", () => {
    const provider = resolveContextProvider({} as ProjectConfig, { repositoryRoot: process.cwd() });
    assert.equal(provider.kind, "none");
  });

  it("resolves AiCodeControlCliProvider when contextProvider is ai-code-control", () => {
    const provider = resolveContextProvider(
      { contextProvider: "ai-code-control" } as ProjectConfig,
      { repositoryRoot: process.cwd() }
    );
    assert.equal(provider.kind, "ai-code-control");
  });
});

describe("AiCodeControlCliProvider", () => {
  it("returns UNAVAILABLE when the executable does not exist", async () => {
    const provider = new AiCodeControlCliProvider({
      executable: "this-binary-does-not-exist-aicw",
      cwd: process.cwd(),
      timeoutMs: 2000,
      maximumOutputBytes: 65536
    });
    const result = await provider.health();

    assert.equal(result.status, "UNAVAILABLE");
  });

  it("parses a real health response and validates it against the schema", async () => {
    const cli = fakeCli({
      health: { schemaVersion: "1.0", status: "ok", error: null, available: true, version: "0.9.0", detail: null }
    });
    const provider = fakeProvider(cli);
    const result = await provider.health();

    assert.equal(result.status, "OK");
    assert.deepEqual(result.status === "OK" ? result.value : null, {
      available: true,
      version: "0.9.0",
      detail: null
    });
  });

  it("parses a real brief response", async () => {
    const cli = fakeCli({
      brief: {
        schemaVersion: "1.0",
        status: "ok",
        error: null,
        summary: "Task touches billing module.",
        relevantFiles: ["src/billing/invoice.ts"]
      }
    });
    const provider = fakeProvider(cli);
    const result = await provider.brief("Fix invoice rounding");

    assert.equal(result.status, "OK");
    assert.deepEqual(result.status === "OK" ? result.value : null, {
      summary: "Task touches billing module.",
      relevantFiles: ["src/billing/invoice.ts"]
    });
  });

  it("parses a real find-symbol response", async () => {
    const cli = fakeCli({
      "find-symbol": {
        schemaVersion: "1.0",
        status: "ok",
        error: null,
        matches: [{ symbol: "InvoiceTotal", file: "src/billing/invoice.ts", line: 42 }]
      }
    });
    const provider = fakeProvider(cli);
    const result = await provider.findSymbol("InvoiceTotal");

    assert.equal(result.status, "OK");
    assert.deepEqual(result.status === "OK" ? result.value : null, [
      { symbol: "InvoiceTotal", file: "src/billing/invoice.ts", line: 42 }
    ]);
  });

  it("parses a real impact response", async () => {
    const cli = fakeCli({
      impact: {
        schemaVersion: "1.0",
        status: "ok",
        error: null,
        symbol: "InvoiceTotal",
        affectedFiles: ["src/billing/invoice.ts", "src/billing/invoice.test.ts"],
        riskNotes: ["Touches money rounding, needs a regression test."]
      }
    });
    const provider = fakeProvider(cli);
    const result = await provider.impact("InvoiceTotal");

    assert.equal(result.status, "OK");
    assert.deepEqual(result.status === "OK" ? result.value.affectedFiles : null, [
      "src/billing/invoice.ts",
      "src/billing/invoice.test.ts"
    ]);
  });

  it("parses a real refresh response", async () => {
    const cli = fakeCli({
      refresh: { schemaVersion: "1.0", status: "ok", error: null, refreshed: true, detail: "indexed 12 files" }
    });
    const provider = fakeProvider(cli);
    const result = await provider.refresh();

    assert.equal(result.status, "OK");
    assert.deepEqual(result.status === "OK" ? result.value : null, { refreshed: true, detail: "indexed 12 files" });
  });

  it("parses and validates a context-package.v1 response", async () => {
    const contextPackage = JSON.parse(readFileSync("templates/reports/context-package.example.json", "utf8"));
    const cli = fakeCli({ "context-compile": contextPackage });
    const provider = fakeProvider(cli);
    const result = await provider.compileContext({
      manifestPath: "manifest.json",
      manifestSha256: "a".repeat(64),
      taskId: "ICM-02",
      maximumTokens: 4000
    });

    assert.equal(result.status, "OK");
    assert.equal(result.status === "OK" ? result.value.contextDigest : null, contextPackage.contextDigest);
  });

  it("maps an in-band error envelope to ERROR", async () => {
    const cli = fakeCli({
      health: { schemaVersion: "1.0", status: "error", error: "index is corrupted", available: null, version: null, detail: null }
    });
    const provider = fakeProvider(cli);
    const result = await provider.health();

    assert.equal(result.status, "ERROR");
    assert.equal(result.status === "ERROR" ? result.reason : null, "index is corrupted");
  });

  it("fails closed (ERROR) on a response that does not match the schema", async () => {
    const cli = fakeCli({ health: { unexpected: "shape" } });
    const provider = fakeProvider(cli);
    const result = await provider.health();

    assert.equal(result.status, "ERROR");
  });

  it("fails closed (ERROR) on non-JSON stdout", async () => {
    const cli = fakeCliRaw("not json at all");
    const provider = fakeProvider(cli);
    const result = await provider.health();

    assert.equal(result.status, "ERROR");
  });

  it("times out and reports ERROR rather than hanging", async () => {
    const cli = fakeCliHanging();
    const provider = new AiCodeControlCliProvider({
      executable: process.execPath,
      baseArgs: [cli],
      cwd: process.cwd(),
      timeoutMs: 200,
      maximumOutputBytes: 65536
    });
    const result = await provider.health();

    assert.equal(result.status, "ERROR");
    assert.match(result.status === "ERROR" ? result.reason : "", /timed out/);
  });
});

function fakeProvider(cliPath: string): AiCodeControlCliProvider {
  return new AiCodeControlCliProvider({
    executable: process.execPath,
    baseArgs: [cliPath],
    cwd: process.cwd(),
    timeoutMs: 5000,
    maximumOutputBytes: 65536
  });
}

function fakeCli(responsesBySubcommand: Record<string, unknown>): string {
  const root = mkdtempSync(join(tmpdir(), "aicw-fake-aicc-"));
  tempRoots.push(root);
  const scriptPath = join(root, "fake-ai-code-control.mjs");
  writeFileSync(
    scriptPath,
    `const responses = ${JSON.stringify(responsesBySubcommand)};\n` +
      `const subcommand = process.argv[2];\n` +
      `const body = responses[subcommand];\n` +
      `if (body === undefined) {\n` +
      `  process.stderr.write("no fake response for " + subcommand);\n` +
      `  process.exit(1);\n` +
      `}\n` +
      `process.stdout.write(JSON.stringify(body));\n`,
    "utf8"
  );
  return scriptPath;
}

function fakeCliRaw(stdout: string): string {
  const root = mkdtempSync(join(tmpdir(), "aicw-fake-aicc-raw-"));
  tempRoots.push(root);
  const scriptPath = join(root, "fake-ai-code-control-raw.mjs");
  writeFileSync(scriptPath, `process.stdout.write(${JSON.stringify(stdout)});\n`, "utf8");
  return scriptPath;
}

function fakeCliHanging(): string {
  const root = mkdtempSync(join(tmpdir(), "aicw-fake-aicc-hang-"));
  tempRoots.push(root);
  const scriptPath = join(root, "fake-ai-code-control-hang.mjs");
  writeFileSync(scriptPath, `setInterval(() => {}, 1000);\n`, "utf8");
  return scriptPath;
}
