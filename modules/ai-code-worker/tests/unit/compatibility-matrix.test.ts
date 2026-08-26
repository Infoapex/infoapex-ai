import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { defaultClaudeConfig, defaultCodexConfig } from "../../src/doctor/doctor.js";
import { REQUIRED_HELP_CAPABILITIES as CLAUDE_REQUIRED_HELP_CAPABILITIES } from "../../src/engines/claude-cli.js";
import { REQUIRED_HELP_CAPABILITIES as CODEX_REQUIRED_HELP_CAPABILITIES } from "../../src/engines/codex-cli.js";
import { SchemaRegistry } from "../../src/schema/json-schema.js";

interface CompatibilityMatrixEngineEntry {
  readonly engine: "codex" | "claude";
  readonly testedVersionRanges?: readonly string[];
  readonly requiredCapabilities: readonly string[];
}

interface CompatibilityMatrix {
  readonly schemaVersion: string;
  readonly engines: readonly CompatibilityMatrixEngineEntry[];
}

function loadMatrix(): CompatibilityMatrix {
  return JSON.parse(readFileSync("docs/compatibility-matrix.json", "utf8")) as CompatibilityMatrix;
}

describe("compatibility matrix data", () => {
  it("validates against its own JSON schema", () => {
    const registry = SchemaRegistry.load({ schemaDirectory: "schemas" });
    const result = registry.validate("compatibility-matrix.schema.json", loadMatrix());

    assert.deepEqual(result.errors, []);
    assert.equal(result.valid, true);
  });

  it("has exactly one entry each for codex and claude", () => {
    const matrix = loadMatrix();
    assert.deepEqual(
      matrix.engines.map((entry) => entry.engine).sort(),
      ["claude", "codex"]
    );
  });

  // Drift check: the matrix is documentation the doctor/adapter code does not read at
  // runtime, so nothing forces it to stay in sync as testedVersionRanges/required
  // capabilities change in code. These two tests are that enforcement - a mismatch
  // here means docs/compatibility-matrix.json needs a documentation update, not a
  // code change.
  it("codex entry matches the real defaultCodexConfig() and REQUIRED_HELP_CAPABILITIES", () => {
    const matrix = loadMatrix();
    const codex = matrix.engines.find((entry) => entry.engine === "codex");
    assert.ok(codex, "matrix must have a codex entry");
    assert.deepEqual(codex.testedVersionRanges, defaultCodexConfig().testedVersionRanges);
    assert.deepEqual(codex.requiredCapabilities, CODEX_REQUIRED_HELP_CAPABILITIES);
    assert.equal(defaultCodexConfig().sandboxMode, "workspace-write");
  });

  it("claude entry matches the real defaultClaudeConfig() and REQUIRED_HELP_CAPABILITIES", () => {
    const matrix = loadMatrix();
    const claude = matrix.engines.find((entry) => entry.engine === "claude");
    assert.ok(claude, "matrix must have a claude entry");
    assert.deepEqual(claude.testedVersionRanges, defaultClaudeConfig().testedVersionRanges);
    assert.deepEqual(claude.requiredCapabilities, CLAUDE_REQUIRED_HELP_CAPABILITIES);
  });
});
