import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, describe, it } from "node:test";
import { installShims } from "../../src/config/shims.js";

const tempDirs: string[] = [];

after(() => {
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function mktemp(): string {
  const dir = mkdtempSync(join(tmpdir(), "aicw-shims-"));
  tempDirs.push(dir);
  return dir;
}

describe("installShims", () => {
  it("installs nothing when no engines are requested", () => {
    const repo = mktemp();
    const result = installShims(repo, []);
    assert.deepEqual(result, { installed: [], skipped: [] });
  });

  it("installs the Codex agent shim and shared skill for engine=codex", () => {
    const repo = mktemp();
    const result = installShims(repo, ["codex"]);

    assert.deepEqual(
      [...result.installed].sort(),
      [join(".agents", "skills", "ai-code-worker", "SKILL.md"), join(".codex", "agents", "ai-code-worker.toml")].sort()
    );
    assert.equal(result.skipped.length, 0);
    assert.equal(existsSync(join(repo, ".codex", "agents", "ai-code-worker.toml")), true);
    assert.equal(existsSync(join(repo, ".agents", "skills", "ai-code-worker", "SKILL.md")), true);
    assert.match(readFileSync(join(repo, ".codex", "agents", "ai-code-worker.toml"), "utf8"), /name = "ai-code-worker"/);
  });

  it("installs the Claude agent shim and shared skill for engine=claude", () => {
    const repo = mktemp();
    const result = installShims(repo, ["claude"]);

    assert.equal(existsSync(join(repo, ".claude", "agents", "ai-code-worker.md")), true);
    assert.equal(existsSync(join(repo, ".claude", "skills", "ai-code-worker", "SKILL.md")), true);
    assert.equal(result.installed.length, 2);
  });

  it("never overwrites a shim the repository already has", () => {
    const repo = mktemp();
    installShims(repo, ["claude"]);
    writeFileSync(join(repo, ".claude", "agents", "ai-code-worker.md"), "custom content\n", "utf8");

    const result = installShims(repo, ["claude"]);

    assert.deepEqual(result.installed, []);
    assert.deepEqual(
      [...result.skipped].sort(),
      [join(".claude", "agents", "ai-code-worker.md"), join(".claude", "skills", "ai-code-worker", "SKILL.md")].sort()
    );
    assert.equal(readFileSync(join(repo, ".claude", "agents", "ai-code-worker.md"), "utf8"), "custom content\n");
  });

  it("ignores an unknown engine name", () => {
    const repo = mktemp();
    const result = installShims(repo, ["not-a-real-engine"]);
    assert.deepEqual(result, { installed: [], skipped: [] });
  });
});

describe("init --install-shims CLI flag", () => {
  it("does not install shims by default", () => {
    const repo = mktemp();
    execFileSync(process.execPath, [resolve("dist/src/cli.js"), "init", "--repo", repo, "--engines", "codex,claude", "--json"], {
      cwd: tmpdir(),
      encoding: "utf8"
    });

    assert.equal(existsSync(join(repo, ".claude", "agents", "ai-code-worker.md")), false);
    assert.equal(existsSync(join(repo, ".codex", "agents", "ai-code-worker.toml")), false);
  });

  it("installs shims when --install-shims is passed", () => {
    const repo = mktemp();
    const output = execFileSync(
      process.execPath,
      [resolve("dist/src/cli.js"), "init", "--repo", repo, "--engines", "codex,claude", "--install-shims", "--json"],
      { cwd: tmpdir(), encoding: "utf8" }
    );
    const report = JSON.parse(output) as { shims?: { installed: readonly string[] } };

    assert.equal(existsSync(join(repo, ".claude", "agents", "ai-code-worker.md")), true);
    assert.equal(existsSync(join(repo, ".codex", "agents", "ai-code-worker.toml")), true);
    assert.equal(report.shims?.installed.length, 4);
  });
});
