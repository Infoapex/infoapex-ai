import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { fullInstall } from "../src/full-install.js";
import { checkInstall, rollbackRelease, uninstall, upgrade } from "../src/release-lifecycle.js";

function createRepository(): string {
  const repository = mkdtempSync(join(tmpdir(), "apex-release-lifecycle-"));
  mkdirSync(join(repository, ".infoapex-ai"), { recursive: true });
  writeFileSync(join(repository, ".infoapex-ai", "config.json"), JSON.stringify({ schemaVersion: "1.0", mode: "integrated", handoffRoot: ".infoapex-ai/runs", planner: { enabled: true }, worker: { enabled: true } }));
  execFileSync("git", ["init", "--initial-branch", "main"], { cwd: repository, stdio: "ignore" });
  execFileSync("git", ["-c", "user.name=Infoapex Test", "-c", "user.email=infoapex-test@example.invalid", "add", "."], { cwd: repository, stdio: "ignore" });
  execFileSync("git", ["-c", "user.name=Infoapex Test", "-c", "user.email=infoapex-test@example.invalid", "commit", "-m", "initial consumer repository"], { cwd: repository, stdio: "ignore" });
  const installed = fullInstall({ repositoryRoot: repository, bundleRoot: process.cwd(), profile: "generic", layout: { backendDir: "backend", frontendDir: "frontend", mlDir: "ml" }, repair: false });
  assert.equal(installed.status, "DONE", JSON.stringify(installed));
  return repository;
}

test("release checks reject invalid profiles and mismatched or unsafe bundle roots", () => {
  const repository = createRepository();
  const unrelatedBundle = mkdtempSync(join(tmpdir(), "apex-unrelated-bundle-"));
  try {
    assert.equal(checkInstall(repository, process.cwd()).status, "PASS");
    assert.equal(checkInstall(repository, process.cwd()).checks.find((check) => check.id === "repository-filesystem-access")?.status, "PASS");
    assert.equal(checkInstall(repository, process.cwd()).checks.find((check) => check.id === "bundle-read-access")?.status, "PASS");
    assert.equal(checkInstall(repository, unrelatedBundle).status, "BLOCKED");
    writeFileSync(join(repository, ".infoapex-ai", "install-profile.json"), JSON.stringify({ schemaVersion: "2.0", profile: "generic" }));
    assert.equal(checkInstall(repository, process.cwd()).status, "BLOCKED");
    assert.equal(checkInstall(join(repository, "..", "missing"), process.cwd()).status, "BLOCKED");
  } finally { rmSync(repository, { recursive: true, force: true }); rmSync(unrelatedBundle, { recursive: true, force: true }); }
});

test("full installer blocks a non-Git target before writing managed files", () => {
  const repository = mkdtempSync(join(tmpdir(), "apex-release-non-git-"));
  try {
    const result = fullInstall({ repositoryRoot: repository, bundleRoot: process.cwd(), profile: "generic", layout: { backendDir: "backend", frontendDir: "frontend", mlDir: "ml" }, repair: false });
    assert.equal(result.status, "BLOCKED");
    assert.match(result.findings.join(" "), /Git repository with an initial commit/);
    assert.equal(existsSync(join(repository, ".ai-code-worker", "config.json")), false);
  } finally { rmSync(repository, { recursive: true, force: true }); }
});

test("install check rejects a stale provider policy before a run", () => {
  const repository = createRepository();
  try {
    const workerConfig = join(repository, ".ai-code-worker", "config.json");
    const config = JSON.parse(readFileSync(workerConfig, "utf8")) as { adapters: { codex: { model: string } } };
    config.adapters.codex.model = "gpt-5.6-terra";
    writeFileSync(workerConfig, JSON.stringify(config));
    const result = checkInstall(repository, process.cwd());
    assert.equal(result.status, "BLOCKED");
    assert.equal(result.checks.find((check) => check.id === "explicit-provider-policy")?.status, "BLOCKED");
  } finally { rmSync(repository, { recursive: true, force: true }); }
});

test("upgrade dry-runs are stable and rollback refuses malformed journals and changed targets", () => {
  const repository = createRepository();
  try {
    const result = upgrade(repository, process.cwd());
    assert.equal(result.status, "PASS", JSON.stringify(result));
    const firstDryRun = rollbackRelease(repository, null, true);
    const secondDryRun = rollbackRelease(repository, null, true);
    assert.deepEqual(secondDryRun, firstDryRun, "dry-run must not mutate its journal");

    const workerConfig = join(repository, ".ai-code-worker", "config.json");
    const before = readFileSync(workerConfig, "utf8");
    writeFileSync(workerConfig, JSON.stringify({ schemaVersion: "1.0", changedByTest: true }));
    const refused = rollbackRelease(repository, null, false);
    assert.equal(refused.status, "BLOCKED", JSON.stringify(refused));
    assert.equal(refused.code, "TARGET_CHANGED");
    assert.match(readFileSync(workerConfig, "utf8"), /changedByTest/);

    writeFileSync(workerConfig, before);
    const rollback = rollbackRelease(repository, null, false);
    assert.equal(rollback.status, "PASS", JSON.stringify(rollback));
    assert.equal(rollbackRelease(repository, null, true).code, "ROLLBACK_ALREADY_APPLIED");

    const malformedId = "upgrade-1234567890123-00000000-0000-0000-0000-000000000000";
    const releases = join(repository, ".infoapex-ai", "releases");
    mkdirSync(releases, { recursive: true });
    writeFileSync(join(releases, `${malformedId}.json`), "{not-json");
    const malformed = rollbackRelease(repository, malformedId, true);
    assert.equal(malformed.status, "BLOCKED");
    assert.equal(malformed.code, "JOURNAL_INVALID");
  } finally { rmSync(repository, { recursive: true, force: true }); }
});

test("upgrade preserves an operator-provisioned execution profile", () => {
  const repository = createRepository();
  try {
    const profilePath = join(repository, ".ai-code-worker", "execution-environment.example.json");
    const profile = {
      schemaVersion: "1.0",
      profileId: "docker-provider",
      kind: "isolated",
      backend: { type: "docker", image: "infoapex/provider-runtime", imageDigest: `sha256:${"a".repeat(64)}` },
      providerExecution: {
        mode: "isolated-container",
        providers: ["codex"],
        credentialVariables: ["OPENAI_API_KEY"],
        egressProxy: {
          networkName: "infoapex-provider-egress",
          proxyUrl: "http://provider-egress-proxy:3128",
          policySha256: "b".repeat(64),
          proxyContainer: "provider-egress-proxy",
          proxyImageDigest: `sha256:${"c".repeat(64)}`
        }
      },
      filesystem: { hostReadDefault: "deny", hostWriteDefault: "deny", mounts: [{ purpose: "worktree", access: "read-write" }] },
      network: { repositoryProcesses: "deny", adapterControlPlane: "provider-only" },
      environment: { inheritByDefault: false, allowedVariables: ["CI", "OPENAI_API_KEY"] },
      limits: { maximumDurationSeconds: 60, maximumOutputBytes: 4096, maximumProcesses: 4 }
    };
    writeFileSync(profilePath, `${JSON.stringify(profile, null, 2)}\n`, "utf8");
    const before = readFileSync(profilePath, "utf8");
    const result = upgrade(repository, process.cwd());
    assert.equal(result.status, "PASS", JSON.stringify(result));
    assert.equal(readFileSync(profilePath, "utf8"), before);
    const ownership = JSON.parse(readFileSync(join(repository, ".infoapex-ai", "install-manifest.json"), "utf8")) as { files: readonly { path: string; owned: boolean }[] };
    assert.equal(ownership.files.find((entry) => entry.path === ".ai-code-worker/config.json")?.owned, true);
  } finally { rmSync(repository, { recursive: true, force: true }); }
});

test("full install validates caller-controlled paths before creating installer state", () => {
  const repository = mkdtempSync(join(tmpdir(), "apex-release-layout-"));
  try {
    const result = fullInstall({ repositoryRoot: repository, bundleRoot: process.cwd(), profile: "generic", layout: { backendDir: "../outside", frontendDir: "frontend", mlDir: null }, repair: false });
    assert.equal(result.status, "BLOCKED");
    assert.equal(existsSync(join(repository, ".infoapex-ai", "install-profile.json")), false);
  } finally { rmSync(repository, { recursive: true, force: true }); }
});

test("uninstall dry-run and apply remove only owned integration while preserving state", () => {
  const repository = createRepository();
  try {
    const state = join(repository, ".ai-code-control", "memory", "DECISIONS.md");
    const evidence = join(repository, ".infoapex-ai", "diagnostics", "support.json");
    mkdirSync(join(repository, ".infoapex-ai", "diagnostics"), { recursive: true });
    writeFileSync(state, "# keep\n", "utf8");
    writeFileSync(evidence, "{\"redacted\":true}\n", "utf8");
    const dryRun = uninstall(repository, true) as { status: string; code: string; removable: readonly string[] };
    assert.equal(dryRun.status, "PASS", JSON.stringify(dryRun));
    assert.equal(dryRun.code, "UNINSTALL_READY");
    assert.equal(existsSync(join(repository, ".ai-code-worker", "config.json")), true);
    const applied = uninstall(repository, false) as { status: string; code: string };
    assert.equal(applied.status, "PASS", JSON.stringify(applied));
    assert.equal(applied.code, "UNINSTALL_APPLIED");
    assert.equal(existsSync(join(repository, ".ai-code-worker", "config.json")), false);
    assert.equal(existsSync(join(repository, ".infoapex-ai", "install-manifest.json")), false);
    assert.equal(existsSync(state), true);
    assert.equal(existsSync(evidence), true);
    assert.equal(existsSync(join(repository, ".infoapex-ai", "config.json")), true);
  } finally { rmSync(repository, { recursive: true, force: true }); }
});

test("uninstall refuses changed installer files and missing ownership proof", () => {
  const repository = createRepository();
  const noManifest = mkdtempSync(join(tmpdir(), "apex-uninstall-no-manifest-"));
  try {
    writeFileSync(join(repository, ".ai-code-worker", "config.json"), "changed\n", "utf8");
    const changed = uninstall(repository, false) as { status: string; code: string };
    assert.deepEqual({ status: changed.status, code: changed.code }, { status: "BLOCKED", code: "TARGET_CHANGED" });
    assert.equal(existsSync(join(repository, ".ai-code-worker", "config.json")), true);
    const missing = uninstall(noManifest, false) as { status: string; code: string };
    assert.deepEqual({ status: missing.status, code: missing.code }, { status: "BLOCKED", code: "OWNERSHIP_MANIFEST_MISSING" });
  } finally { rmSync(repository, { recursive: true, force: true }); rmSync(noManifest, { recursive: true, force: true }); }
});
