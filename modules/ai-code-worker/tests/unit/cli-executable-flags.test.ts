import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, describe, it } from "node:test";

const tempRepos: string[] = [];
const tempRoots: string[] = [];

after(() => {
  for (const root of tempRoots) {
    rmSync(root, { recursive: true, force: true });
  }

  for (const repo of tempRepos) {
    rmSync(repo, { recursive: true, force: true });
  }
});

describe("CLI executable flags", () => {
  it("passes --claude-executable through to the Claude doctor check", () => {
    const executable = writeFakeCli("custom-claude", "claude");
    const report = invokeDoctorJson(["--engine", "claude", "--claude-executable", executable], {});

    assert.equal(report.status, "PASS");
    assert.equal(report.engineDoctor?.executable, executable);
  });

  it("passes --codex-executable through to the Codex doctor check", () => {
    const repo = createGitRepository();
    const executable = writeFakeCli("custom-codex", "codex");
    const report = invokeDoctorJson(["--engine", "codex", "--codex-executable", executable], { repo });

    assert.equal(report.status, "PASS");
    assert.equal(report.engineDoctor?.executable, executable);
  });

  it("discovers the Claude executable when --claude-executable is omitted", () => {
    const repo = createGitRepository();
    const report = invokeDoctorJson(["--engine", "claude"], { repo });

    assert.match(report.engineDoctor?.executable ?? "", /claude/i);
  });

  it("discovers the Codex executable when --codex-executable is omitted", () => {
    const repo = createGitRepository();
    const report = invokeDoctorJson(["--engine", "codex"], { repo });

    assert.match(report.engineDoctor?.executable ?? "", /codex/i);
  });
});

interface DoctorCliReport {
  readonly status: string;
  readonly engineDoctor?: {
    readonly executable?: string;
  } | null;
}

function invokeDoctorJson(args: readonly string[], options: { readonly repo?: string }): DoctorCliReport {
  const repo = options.repo ?? createGitRepository();

  // doctor exits with code 2 on BLOCKED (execFileSync throws on any non-zero exit) -
  // the exit code itself isn't what these tests assert on, so tolerate it and read
  // stdout (still JSON either way) off the thrown error.
  let output: string;
  try {
    output = execFileSync(process.execPath, [resolve("dist/src/cli.js"), "doctor", "--repo", repo, "--json", ...args], {
      cwd: tmpdir(),
      encoding: "utf8"
    });
  } catch (error) {
    output = (error as { readonly stdout?: string }).stdout ?? "";
  }

  return JSON.parse(output) as DoctorCliReport;
}

function createGitRepository(): string {
  const repo = mkdtempSync(join(tmpdir(), "aicw-cli-executable-flags-"));
  tempRepos.push(repo);

  execFileSync("git", ["init"], { cwd: repo, stdio: "ignore" });
  writeFileSync(join(repo, "README.md"), "# fixture\n");
  execFileSync("git", ["add", "README.md"], { cwd: repo, stdio: "ignore" });
  execFileSync("git", ["-c", "user.name=ai-code-worker", "-c", "user.email=worker@example.test", "commit", "-m", "init"], {
    cwd: repo,
    stdio: "ignore"
  });

  return repo;
}

function writeFakeCli(name: string, engine: "claude" | "codex", root = mkdtempSync(join(tmpdir(), "aicw-cli-fake-"))): string {
  if (!tempRoots.includes(root)) {
    tempRoots.push(root);
  }

  const path = join(root, process.platform === "win32" ? `${name}.cmd` : name);
  const source = process.platform === "win32" ? windowsFakeCli(engine) : posixFakeCli(engine);

  writeFileSync(path, source, "utf8");
  chmodSync(path, 0o755);

  return path;
}

function windowsFakeCli(engine: "claude" | "codex"): string {
  // Literal parentheses inside an `echo` that is itself inside an `if (...)` block
  // prematurely close the block in Windows batch parsing - escape them with `^`.
  const version = engine === "claude" ? "2.1.0 ^(Claude Code^)" : "codex-cli 0.146.0-alpha.3.1";
  const help = engine === "claude"
    ? "--output-format stream-json --tools --allowedTools --permission-mode --session-id --no-session-persistence --input-format"
    : "--json --cd --sandbox";

  return `@echo off
if "%1"=="--version" (
  echo ${version}
  exit /b 0
)
echo ${help}
exit /b 0
`;
}

function posixFakeCli(engine: "claude" | "codex"): string {
  const version = engine === "claude" ? "2.1.0 (Claude Code)" : "codex-cli 0.146.0-alpha.3.1";
  const help = engine === "claude"
    ? "--output-format stream-json --tools --allowedTools --permission-mode --session-id --no-session-persistence --input-format"
    : "--json --cd --sandbox";

  return `#!/bin/sh
if [ "$1" = "--version" ]; then
  printf '%s\\n' '${version}'
  exit 0
fi
printf '%s\\n' '${help}'
exit 0
`;
}
