import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { delegate } from "../src/delegate.js";
import type { ModuleDescriptor } from "../src/registry.js";

// Fixture "modules" are plain scripts under a throwaway bundle root - delegate.ts only
// ever spawns `execPath <cliRelativePath> <subcommand> ...args`, so a script that reads
// its own argv and prints whatever the test wants is a faithful stand-in for a real
// module's CLI without depending on any of the actual bundled modules.
function bundleWithFixtureCli(script: string): { bundleRoot: string; module: ModuleDescriptor } {
  const bundleRoot = realpathSync.native(mkdtempSync(join(tmpdir(), "delegate-fixture-")));
  const cliRelativePath = join("fixture-module", "cli.js");
  const cliPath = join(bundleRoot, cliRelativePath);
  mkdirSync(dirname(cliPath), { recursive: true });
  writeFileSync(cliPath, script, "utf8");
  return {
    bundleRoot,
    module: { name: "fixture-module", cliRelativePath, commandMap: { run: "go" } }
  };
}

test("MODULE_NOT_AVAILABLE when the module's built CLI does not exist on disk", () => {
  const bundleRoot = realpathSync.native(mkdtempSync(join(tmpdir(), "delegate-missing-")));
  try {
    const module: ModuleDescriptor = { name: "ghost-module", cliRelativePath: join("ghost", "cli.js"), commandMap: { run: "go" } };
    const envelope = delegate({ command: "run", module, subcommand: "go", bundleRoot, args: [] });
    assert.equal(envelope.status, "BLOCKED");
    assert.equal(envelope.exitCode, 2);
    assert.equal(envelope.module, "ghost-module");
    const body = envelope.body as { findings: readonly { code: string }[] };
    assert.equal(body.findings[0]!.code, "MODULE_NOT_AVAILABLE");
  } finally {
    rmSync(bundleRoot, { recursive: true, force: true });
  }
});

test("a module's own status field wins: DONE/PASS -> PASS, WARN -> WARN, BLOCKED/FAILED -> BLOCKED", () => {
  const { bundleRoot, module } = bundleWithFixtureCli(
    `console.log(JSON.stringify({ status: process.argv[3] })); process.exitCode = process.argv[3] === "PASS" || process.argv[3] === "DONE" ? 0 : 2;`
  );
  try {
    for (const [reported, expected] of [["PASS", "PASS"], ["DONE", "PASS"], ["WARN", "WARN"], ["BLOCKED", "BLOCKED"], ["FAILED", "BLOCKED"]] as const) {
      const envelope = delegate({ command: "run", module, subcommand: "go", bundleRoot, args: [reported] });
      assert.equal(envelope.status, expected, `status ${reported} should map to ${expected}`);
      assert.deepEqual(envelope.body, { status: reported });
    }
  } finally {
    rmSync(bundleRoot, { recursive: true, force: true });
  }
});

test("falls back to the process exit code when the module's JSON has no recognized status field", () => {
  const { bundleRoot, module } = bundleWithFixtureCli(
    `console.log(JSON.stringify({ ok: true })); process.exitCode = Number(process.argv[3]);`
  );
  try {
    const okEnvelope = delegate({ command: "run", module, subcommand: "go", bundleRoot, args: ["0"] });
    assert.equal(okEnvelope.status, "PASS");
    assert.equal(okEnvelope.exitCode, 0);

    const failEnvelope = delegate({ command: "run", module, subcommand: "go", bundleRoot, args: ["1"] });
    assert.equal(failEnvelope.status, "BLOCKED");
    assert.equal(failEnvelope.exitCode, 1);
  } finally {
    rmSync(bundleRoot, { recursive: true, force: true });
  }
});

test("falls back to parsing stderr when stdout is not valid JSON (a module's own error-path convention)", () => {
  // Mirrors ai-code-review's top-level catch: it writes structured JSON to stderr for a
  // thrown error while every normal completion goes to stdout. Losing that body into a
  // generic NON_JSON_OUTPUT wrapper would hide a real, structured diagnostic.
  const { bundleRoot, module } = bundleWithFixtureCli(
    `console.error(JSON.stringify({ status: "BLOCKED", message: "config missing" })); process.exitCode = 2;`
  );
  try {
    const envelope = delegate({ command: "run", module, subcommand: "go", bundleRoot, args: [] });
    assert.equal(envelope.status, "BLOCKED");
    assert.deepEqual(envelope.body, { status: "BLOCKED", message: "config missing" });
  } finally {
    rmSync(bundleRoot, { recursive: true, force: true });
  }
});

test("stdout wins over stderr when both happen to be parseable JSON", () => {
  const { bundleRoot, module } = bundleWithFixtureCli(
    `console.error(JSON.stringify({ status: "BLOCKED" })); console.log(JSON.stringify({ status: "PASS" })); process.exitCode = 0;`
  );
  try {
    const envelope = delegate({ command: "run", module, subcommand: "go", bundleRoot, args: [] });
    assert.deepEqual(envelope.body, { status: "PASS" });
    assert.equal(envelope.status, "PASS");
  } finally {
    rmSync(bundleRoot, { recursive: true, force: true });
  }
});

test("NON_JSON_OUTPUT when neither stream parses as JSON, with the raw text preserved for debugging", () => {
  const { bundleRoot, module } = bundleWithFixtureCli(
    `console.error("Missing required option: --plan <path>"); process.exitCode = 1;`
  );
  try {
    const envelope = delegate({ command: "run", module, subcommand: "go", bundleRoot, args: [] });
    assert.equal(envelope.status, "BLOCKED");
    const body = envelope.body as { findings: readonly { code: string; message: string }[] };
    assert.equal(body.findings[0]!.code, "NON_JSON_OUTPUT");
    assert.match(body.findings[0]!.message, /Missing required option: --plan/);
  } finally {
    rmSync(bundleRoot, { recursive: true, force: true });
  }
});

test("appends --json to forwarded args when the caller did not already pass it, without duplicating it when they did", () => {
  const { bundleRoot, module } = bundleWithFixtureCli(
    `console.log(JSON.stringify({ status: "PASS", argv: process.argv.slice(3) }));`
  );
  try {
    const withoutJson = delegate({ command: "run", module, subcommand: "go", bundleRoot, args: ["--repo", "."] });
    assert.deepEqual((withoutJson.body as { argv: string[] }).argv, ["--repo", ".", "--json"]);

    const withJson = delegate({ command: "run", module, subcommand: "go", bundleRoot, args: ["--repo", ".", "--json"] });
    assert.deepEqual((withJson.body as { argv: string[] }).argv, ["--repo", ".", "--json"]);
  } finally {
    rmSync(bundleRoot, { recursive: true, force: true });
  }
});

test("preserves spaces, Unicode, quotes, and JSON event arguments across the process boundary", () => {
  const { bundleRoot, module } = bundleWithFixtureCli(
    `console.log(JSON.stringify({ status: "PASS", argv: process.argv.slice(3) }));`
  );
  try {
    const event = '{"type":"task.completed","message":"München \\"quoted\\""}';
    const pathWithSpaces = "C:\\repo with spaces\\Δ";
    const envelope = delegate({ command: "run", module, subcommand: "go", bundleRoot, args: ["--repo", pathWithSpaces, "--event", event] });
    assert.deepEqual((envelope.body as { argv: string[] }).argv, ["--repo", pathWithSpaces, "--event", event, "--json"]);
    assert.equal(envelope.status, "PASS");
  } finally {
    rmSync(bundleRoot, { recursive: true, force: true });
  }
});

test("malformed event output is a stable blocked diagnostic rather than permissive parsing", () => {
  const { bundleRoot, module } = bundleWithFixtureCli(
    `console.log('{"type":"event"} trailing-data'); process.exitCode = 2;`
  );
  try {
    const envelope = delegate({ command: "run", module, subcommand: "go", bundleRoot, args: [] });
    assert.equal(envelope.status, "BLOCKED");
    assert.equal((envelope.body as { findings: readonly { code: string }[] }).findings[0]!.code, "NON_JSON_OUTPUT");
  } finally {
    rmSync(bundleRoot, { recursive: true, force: true });
  }
});

test("null is a valid parsed JSON body, distinct from a parse failure", () => {
  const { bundleRoot, module } = bundleWithFixtureCli(`console.log("null"); process.exitCode = 0;`);
  try {
    const envelope = delegate({ command: "run", module, subcommand: "go", bundleRoot, args: [] });
    assert.equal(envelope.body, null);
    assert.equal(envelope.status, "PASS");
  } finally {
    rmSync(bundleRoot, { recursive: true, force: true });
  }
});
