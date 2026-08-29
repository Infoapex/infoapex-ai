import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, describe, it } from "node:test";
import { buildAgentsMdBlock, proposeAgentsMdBlock, writeAgentsMdBlock } from "../../src/config/agents-md-block.js";
import { defaultProjectConfigTemplate, initProjectConfig, updateProjectConfig } from "../../src/config/init.js";

const tempDirs: string[] = [];

after(() => {
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function mktemp(): string {
  const dir = mkdtempSync(join(tmpdir(), "aicw-init-"));
  tempDirs.push(dir);
  return dir;
}

describe("initProjectConfig", () => {
  it("creates .ai-code-worker/config.json and README.md", () => {
    const repo = mktemp();
    const result = initProjectConfig(repo);

    assert.equal(result.status, "CREATED");
    if (result.status !== "CREATED") return;
    assert.equal(result.configPath, join(repo, ".ai-code-worker", "config.json"));
    assert.equal(existsSync(result.readmePath), true);

    const config = JSON.parse(readFileSync(result.configPath, "utf8"));
    assert.deepEqual(config, defaultProjectConfigTemplate());
  });

  it("refuses to overwrite an existing config without --force", () => {
    const repo = mktemp();
    initProjectConfig(repo);
    writeFileSync(join(repo, ".ai-code-worker", "config.json"), '{"schemaVersion":"1.0","custom":true}\n', "utf8");

    const result = initProjectConfig(repo);

    assert.equal(result.status, "ALREADY_EXISTS");
    const config = JSON.parse(readFileSync(join(repo, ".ai-code-worker", "config.json"), "utf8"));
    assert.equal(config.custom, true);
  });

  it("overwrites with --force", () => {
    const repo = mktemp();
    initProjectConfig(repo);
    writeFileSync(join(repo, ".ai-code-worker", "config.json"), '{"schemaVersion":"1.0","custom":true}\n', "utf8");

    const result = initProjectConfig(repo, { force: true });

    assert.equal(result.status, "CREATED");
    const config = JSON.parse(readFileSync(join(repo, ".ai-code-worker", "config.json"), "utf8"));
    assert.equal(config.custom, undefined);
  });
});

describe("updateProjectConfig", () => {
  it("reports MISSING when there is no config.json yet", () => {
    const repo = mktemp();
    const result = updateProjectConfig(repo);
    assert.equal(result.status, "MISSING");
  });

  it("is a no-op when the config already has every template key", () => {
    const repo = mktemp();
    initProjectConfig(repo);

    const result = updateProjectConfig(repo);

    assert.equal(result.status, "UNCHANGED");
    assert.deepEqual(result.addedKeys, []);
  });

  it("adds only missing top-level keys, preserving existing values and unrelated custom keys", () => {
    const repo = mktemp();
    const dir = join(repo, ".ai-code-worker");
    initProjectConfig(repo);
    writeFileSync(
      join(dir, "config.json"),
      JSON.stringify({ schemaVersion: "1.0", contextProvider: "ai-code-control", customField: "keep-me" }, null, 2),
      "utf8"
    );

    const result = updateProjectConfig(repo);

    assert.equal(result.status, "UPDATED");
    assert.deepEqual([...result.addedKeys].sort(), ["contextPackage", "maximumParallelWriters", "stateRoot", "syncRootPolicy"]);

    const config = JSON.parse(readFileSync(join(dir, "config.json"), "utf8"));
    assert.equal(config.contextProvider, "ai-code-control", "existing value must not be overwritten by the default");
    assert.equal(config.customField, "keep-me", "unrelated user key must survive");
    assert.equal(config.maximumParallelWriters, 2, "missing key gets the default value");
  });
});

describe("AGENTS.md block", () => {
  it("proposes the block without writing anything when AGENTS.md does not exist", () => {
    const repo = mktemp();
    const proposal = proposeAgentsMdBlock(repo);

    assert.equal(proposal.alreadyPresent, false);
    assert.equal(existsSync(proposal.path), false);
    assert.match(proposal.content, /## ai-code-worker/);
  });

  it("appends the block to a fresh AGENTS.md on explicit write", () => {
    const repo = mktemp();
    const result = writeAgentsMdBlock(repo);

    assert.equal(result.status, "APPENDED");
    const content = readFileSync(result.path, "utf8");
    assert.equal(content, buildAgentsMdBlock());
  });

  it("appends after existing content without touching it, and is idempotent", () => {
    const repo = mktemp();
    writeFileSync(join(repo, "AGENTS.md"), "# Project instructions\n\nSome unrelated rule.\n", "utf8");

    const first = writeAgentsMdBlock(repo);
    assert.equal(first.status, "APPENDED");
    const afterFirst = readFileSync(join(repo, "AGENTS.md"), "utf8");
    assert.match(afterFirst, /Some unrelated rule\./);
    assert.match(afterFirst, /## ai-code-worker/);

    const second = writeAgentsMdBlock(repo);
    assert.equal(second.status, "ALREADY_PRESENT");
    assert.equal(readFileSync(join(repo, "AGENTS.md"), "utf8"), afterFirst);
  });

  it("detects an older-versioned block as STALE, not MISSING or CURRENT", () => {
    const repo = mktemp();
    writeFileSync(
      join(repo, "AGENTS.md"),
      "# Project instructions\n\n<!-- ai-code-worker:block v0 -->\n## ai-code-worker\n\nOld content.\n<!-- /ai-code-worker:block -->\n",
      "utf8"
    );

    const proposal = proposeAgentsMdBlock(repo);

    assert.equal(proposal.state, "STALE");
    assert.equal(proposal.alreadyPresent, false);
    assert.equal(proposal.existingVersion, "0");
  });

  it("replaces exactly the stale block's span on explicit write, preserving everything else", () => {
    const repo = mktemp();
    writeFileSync(
      join(repo, "AGENTS.md"),
      "# Project instructions\n\nSome unrelated rule.\n\n<!-- ai-code-worker:block v0 -->\n## ai-code-worker\n\nOld content.\n<!-- /ai-code-worker:block -->\n\nAnother unrelated rule.\n",
      "utf8"
    );

    const result = writeAgentsMdBlock(repo);

    assert.equal(result.status, "REPLACED");
    assert.equal(result.previousVersion, "0");
    const content = readFileSync(join(repo, "AGENTS.md"), "utf8");
    assert.match(content, /Some unrelated rule\./);
    assert.match(content, /Another unrelated rule\./);
    assert.doesNotMatch(content, /Old content\./);
    assert.match(content, /<!-- ai-code-worker:block v1 -->/);
    assert.doesNotMatch(content, /<!-- ai-code-worker:block v0 -->/);

    // Idempotent afterward: the freshly-written block is now CURRENT.
    const second = writeAgentsMdBlock(repo);
    assert.equal(second.status, "ALREADY_PRESENT");
  });

  it("does not touch AGENTS.md when the existing block has no matching end marker (malformed)", () => {
    const repo = mktemp();
    const malformed = "# Project instructions\n\n<!-- ai-code-worker:block v0 -->\n## ai-code-worker\n\nNo end marker here.\n";
    writeFileSync(join(repo, "AGENTS.md"), malformed, "utf8");

    const proposal = proposeAgentsMdBlock(repo);
    assert.equal(proposal.state, "MISSING");

    const result = writeAgentsMdBlock(repo);
    assert.equal(result.status, "APPENDED");
    const content = readFileSync(join(repo, "AGENTS.md"), "utf8");
    assert.match(content, /No end marker here\./);
    assert.match(content, /<!-- ai-code-worker:block v1 -->/);
  });
});

describe("init/update CLI commands", () => {
  it("ai-code-worker init then update round-trips through the CLI", () => {
    const repo = mktemp();
    const initOutput = execFileSync(process.execPath, [resolve("dist/src/cli.js"), "init", "--repo", repo, "--json"], {
      cwd: tmpdir(),
      encoding: "utf8"
    });
    const initReport = JSON.parse(initOutput) as { status: string; agentsMd?: { alreadyPresent: boolean } };
    assert.equal(initReport.status, "CREATED");
    assert.equal(initReport.agentsMd?.alreadyPresent, false, "init proposes but does not write AGENTS.md by default");
    assert.equal(existsSync(join(repo, "AGENTS.md")), false);

    // init exits 1 on ALREADY_EXISTS (execFileSync throws on any non-zero exit) -
    // stdout is still valid JSON either way.
    let secondInitOutput: string;
    try {
      secondInitOutput = execFileSync(process.execPath, [resolve("dist/src/cli.js"), "init", "--repo", repo, "--json"], {
        cwd: tmpdir(),
        encoding: "utf8"
      });
    } catch (error) {
      secondInitOutput = (error as { readonly stdout?: string }).stdout ?? "";
    }
    assert.equal((JSON.parse(secondInitOutput) as { status: string }).status, "ALREADY_EXISTS");

    const updateOutput = execFileSync(process.execPath, [resolve("dist/src/cli.js"), "update", "--repo", repo, "--json"], {
      cwd: tmpdir(),
      encoding: "utf8"
    });
    assert.equal((JSON.parse(updateOutput) as { status: string }).status, "UNCHANGED");
  });

  it("--engines scaffolds adapter stubs and --write-agents-md confirms the AGENTS.md block", () => {
    const repo = mktemp();
    const output = execFileSync(
      process.execPath,
      [resolve("dist/src/cli.js"), "init", "--repo", repo, "--engines", "codex,claude", "--write-agents-md", "--json"],
      { cwd: tmpdir(), encoding: "utf8" }
    );
    const report = JSON.parse(output) as { status: string; configPath: string; agentsMd?: { status: string } };

    assert.equal(report.status, "CREATED");
    assert.equal(report.agentsMd?.status, "APPENDED");
    assert.equal(existsSync(join(repo, "AGENTS.md")), true);

    const config = JSON.parse(readFileSync(report.configPath, "utf8"));
    assert.deepEqual(config.adapters, { codex: {}, claude: {} });
  });

  it("--write-agents-md still works on a repeat init when config.json already exists (ALREADY_EXISTS)", () => {
    const repo = mktemp();
    execFileSync(process.execPath, [resolve("dist/src/cli.js"), "init", "--repo", repo, "--json"], {
      cwd: tmpdir(),
      encoding: "utf8"
    });
    assert.equal(existsSync(join(repo, "AGENTS.md")), false);

    // ALREADY_EXISTS exits 1 - tolerate it the same way as the round-trip test above.
    let output: string;
    try {
      output = execFileSync(
        process.execPath,
        [resolve("dist/src/cli.js"), "init", "--repo", repo, "--write-agents-md", "--json"],
        { cwd: tmpdir(), encoding: "utf8" }
      );
    } catch (error) {
      output = (error as { readonly stdout?: string }).stdout ?? "";
    }
    const report = JSON.parse(output) as { status: string; agentsMd?: { status: string } };

    assert.equal(report.status, "ALREADY_EXISTS");
    assert.equal(report.agentsMd?.status, "APPENDED");
    assert.equal(existsSync(join(repo, "AGENTS.md")), true);
  });

  it("--write-agents-md replaces a stale block on a repeat init", () => {
    const repo = mktemp();
    execFileSync(process.execPath, [resolve("dist/src/cli.js"), "init", "--repo", repo, "--write-agents-md", "--json"], {
      cwd: tmpdir(),
      encoding: "utf8"
    });
    const agentsMdPath = join(repo, "AGENTS.md");
    writeFileSync(agentsMdPath, readFileSync(agentsMdPath, "utf8").replace("block v1", "block v0"), "utf8");

    let output: string;
    try {
      output = execFileSync(
        process.execPath,
        [resolve("dist/src/cli.js"), "init", "--repo", repo, "--write-agents-md", "--json"],
        { cwd: tmpdir(), encoding: "utf8" }
      );
    } catch (error) {
      output = (error as { readonly stdout?: string }).stdout ?? "";
    }
    const report = JSON.parse(output) as { agentsMd?: { status: string; previousVersion?: string } };

    assert.equal(report.agentsMd?.status, "REPLACED");
    assert.equal(report.agentsMd?.previousVersion, "0");
    assert.match(readFileSync(agentsMdPath, "utf8"), /block v1/);
  });
});
