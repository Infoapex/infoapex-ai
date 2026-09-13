import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, describe, it } from "node:test";
import { runDoctor } from "../../src/doctor/doctor.js";
import { gitPreflight } from "../../src/git/preflight.js";

const tempRepos: string[] = [];

after(() => {
  for (const repo of tempRepos) {
    rmSync(repo, { recursive: true, force: true });
  }
});

describe("doctor preflight", () => {
  it("reads Git worktree/common-dir and returns a passing report for a clean fixture repo", () => {
    const repo = createGitRepository();
    const preflight = gitPreflight(repo);

    assert.equal(preflight.ok, true);
    // requestedPath is realpathSync.native()'d (see git/preflight.ts), so it may
    // differ from the raw `repo` string on a host where that path has a distinct
    // short-name alias (confirmed live on GitHub Actions windows-latest) - compare
    // against the same canonicalization, not the raw input.
    assert.equal(preflight.requestedPath, realpathSync.native(repo));

    const report = runDoctor({ repositoryPath: repo });

    assert.equal(report.status, "PASS");
    assert.equal(report.repository.ok, true);
    assert.equal(report.stateRoot?.insideRepository, false);
    assert.equal(report.syncRoot?.verdict, "pass");
    assert.equal(report.executionEnvironment?.supported, true);
  });

  it("exposes doctor as a JSON CLI command", () => {
    const repo = createGitRepository();
    const output = execFileSync(process.execPath, [resolve("dist/src/cli.js"), "doctor", "--repo", repo, "--json"], {
      cwd: tmpdir(),
      encoding: "utf8"
    });
    const report = JSON.parse(output) as { status: string };

    assert.equal(report.status, "PASS");
  });

  it("leaves engineDoctor null and status unchanged when no --engine is requested", () => {
    const repo = createGitRepository();
    const report = runDoctor({ repositoryPath: repo });

    assert.equal(report.engineDoctor, null);
    assert.equal(report.status, "PASS");
  });

  it("wires --engine claude to the Claude Code CLI doctor check", () => {
    const repo = createGitRepository();
    const report = runDoctor({ repositoryPath: repo, engine: "claude" });

    assert.ok(report.engineDoctor !== null);
    // Fail-closed contract, independent of whether `claude` happens to be on this
    // machine's PATH: status is BLOCKED iff there is a blocker finding, and a missing
    // binary always reports CLAUDE_VERSION_UNAVAILABLE.
    if (!isOnPath("claude")) {
      assert.equal(report.engineDoctor?.status, "BLOCKED");
      assert.equal(report.status, "BLOCKED");
      assert.ok(report.findings.some((finding) => finding.code === "CLAUDE_VERSION_UNAVAILABLE"));
    }
    assert.equal(report.status === "BLOCKED", report.findings.some((finding) => finding.severity === "blocker"));
  });

  it("wires --engine codex to the Codex CLI doctor check and fails closed when it is missing", () => {
    const repo = createGitRepository();
    const report = runDoctor({ repositoryPath: repo, engine: "codex" });

    assert.ok(report.engineDoctor !== null);
    if (!isOnPath("codex")) {
      assert.equal(report.engineDoctor?.status, "BLOCKED");
      assert.equal(report.status, "BLOCKED");
      assert.ok(report.findings.some((finding) => finding.code === "CODEX_VERSION_UNAVAILABLE"));
    }
  });
});

function isOnPath(executable: string): boolean {
  const probe = spawnSync(executable, ["--version"], { encoding: "utf8", timeout: 10_000, windowsHide: true });
  return probe.error === undefined;
}

function createGitRepository(): string {
  const repo = mkdtempSync(join(tmpdir(), "aicw-doctor-"));
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
