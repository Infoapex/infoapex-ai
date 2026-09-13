import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { DockerExecutionEnvironment, FakeExecutionEnvironment, LocalIsolatedExecutionEnvironment, type ExecutionEnvironment } from "../../src/execution/environment.js";
import type { EngineProcessRunner, EngineProcessSyncResult } from "../../src/engines/process-runner.js";
import type { BufferedProcessResult } from "../../src/engines/spawn-buffered.js";
import { canonicalJson, sha256 } from "../../src/manifest/normalize.js";
import type { JsonValue } from "../../src/schema/json-schema.js";

describe("fake execution environment", () => {
  it("reports isolated profile capabilities and profile digest", () => {
    const profile = readJson("templates/project/.ai-code-worker/execution-environment.example.json");
    const report = new FakeExecutionEnvironment().doctor(profile);

    assert.equal(report.backend, "fake-isolated");
    assert.equal(report.supported, true);
    assert.equal(report.kind, "isolated");
    assert.equal(report.profileSha256, sha256(canonicalJson(profile as JsonValue)));
    assert.equal(report.missingCapabilities.length, 0);
    assert.ok(report.capabilities.includes("network-deny-repository-processes"));
    assert.ok(report.capabilities.includes("network-provider-only-adapter-control-plane"));
    assert.ok(report.capabilities.includes("provider-execution-isolated"));
    assert.equal(report.providerSupported, true);
    assert.ok(new FakeExecutionEnvironment().providerProcessRunner?.(profile, "codex"));
  });

  it("does not report the adapter control-plane capability when the profile allows it", () => {
    // adapterControlPlane has been a required schema field but was never read by
    // either backend until now. This locks in that the new check actually branches
    // on the profile value instead of always reporting the capability as present.
    const profile = readJson("templates/project/.ai-code-worker/execution-environment.example.json") as Record<string, unknown>;
    const network = profile.network as Record<string, unknown>;
    const openProfile = { ...profile, network: { ...network, adapterControlPlane: "allowlist" } };
    const report = new FakeExecutionEnvironment().doctor(openProfile);

    assert.ok(!report.capabilities.includes("network-provider-only-adapter-control-plane"));
  });

  it("fails closed when isolated filesystem restrictions are missing", () => {
    const profile = readJson("templates/project/.ai-code-worker/execution-environment.example.json") as Record<string, unknown>;
    const filesystem = profile.filesystem as Record<string, unknown>;
    const unsafeProfile = {
      ...profile,
      filesystem: {
        ...filesystem,
        hostReadDefault: "allow"
      }
    };
    const report = new FakeExecutionEnvironment().doctor(unsafeProfile);

    assert.equal(report.supported, false);
    assert.ok(report.missingCapabilities.includes("filesystem-restricted"));
  });

  it("runs commands through the local isolated backend with a scrubbed environment", async () => {
    const profile = readJson("templates/project/.ai-code-worker/execution-environment.example.json");
    const environment = new LocalIsolatedExecutionEnvironment();
    const report = environment.doctor(profile);

    assert.equal(report.backend, "local-isolated");
    assert.equal(report.securityBoundary, "host-process");
    assert.equal(report.supported, true);
    assert.equal(report.missingCapabilities.length, 0);
    assert.equal(report.providerSupported, false);
    assert.ok(report.providerWarnings.some((warning) => warning.includes("provider boundary")));
    assert.ok(!report.capabilities.includes("provider-execution-isolated"));
    const environmentContract: ExecutionEnvironment = environment;
    assert.equal(environmentContract.providerProcessRunner?.(profile, "claude"), undefined);

    const result = await environment.run({
      executable: process.execPath,
      args: ["-e", "process.stdout.write(process.env.SECRET_TOKEN ? 'leaked' : 'clean')"],
      cwd: process.cwd(),
      timeoutMs: 5000,
      maximumOutputBytes: 1024,
      env: {}
    });

    assert.equal(result.status, 0);
    assert.equal(result.stdout, "clean");
  });

  it("proves the Docker backend with a pinned image and denies host/network access", async () => {
    const profile = readJson("templates/project/.ai-code-worker/execution-environment.example.json") as Record<string, unknown>;
    const pinned = {
      ...profile,
      backend: {
        type: "docker",
        image: "node:22-alpine",
        imageDigest: "sha256:c610fcdfb1d5b4740dd70c284ed3cb16bb857e0f7166196e36a5501df7a3aa32"
      }
    };
    const environment = new DockerExecutionEnvironment();
    const report = environment.doctor(pinned);

    if (report.backend === "docker" && report.supported) {
      assert.equal(report.securityBoundary, "os-isolated");
      assert.deepEqual(report.missingCapabilities, []);
      const result = await environment.runWithProfile(pinned, {
        executable: "node",
        args: ["-e", "process.stdout.write(process.env.CI === 'true' && !process.env.SECRET_TOKEN ? 'clean' : 'leaked')"],
        cwd: process.cwd(),
        timeoutMs: 10_000,
        maximumOutputBytes: 1024,
        env: { CI: "true" }
      });
      assert.equal(result.status, 0);
      assert.equal(result.stdout, "clean");

      const rejected = await environment.runWithProfile(pinned, {
        executable: "node",
        args: ["-e", "process.stdout.write('must-not-run')"],
        cwd: process.cwd(),
        timeoutMs: 10_000,
        maximumOutputBytes: 1024,
        env: { SECRET_TOKEN: "must-not-cross" }
      });
      assert.equal(rejected.status, null);
      assert.match(rejected.stderr, /not allowlisted/);
    } else {
      // CI hosts without Docker must remain fail-closed rather than weakening
      // the contract to make the test green.
      assert.equal(report.supported, false);
    }
  });

  it("routes a provisioned provider through the attested internal proxy network", () => {
    const policySha256 = "a".repeat(64);
    const profile = readJson("templates/project/.ai-code-worker/execution-environment.example.json") as Record<string, unknown>;
    const providerProfile = {
      ...profile,
      backend: {
        type: "docker",
        image: "infoapex/provider-runtime",
        imageDigest: `sha256:${"b".repeat(64)}`
      },
      providerExecution: {
        mode: "isolated-container",
        egressProxy: {
          networkName: "infoapex-provider-egress",
          proxyUrl: "http://provider-egress-proxy:3128",
          policySha256,
          proxyContainer: "provider-egress-proxy",
          proxyImageDigest: `sha256:${"c".repeat(64)}`
        },
        credentialVariables: ["OPENAI_API_KEY"]
      },
      environment: {
        ...(profile.environment as Record<string, unknown>),
        allowedVariables: ["CI", "NO_COLOR", "OPENAI_API_KEY"]
      }
    };
    const calls: Array<{ executable: string; args: readonly string[] }> = [];
    const dockerRunner: EngineProcessRunner = {
      runSync(executable, args) {
        calls.push({ executable, args });
        if (args[0] === "network") return fakeSync(JSON.stringify({ Internal: true, Labels: { "com.infoapex.ai/provider-egress-policy-sha256": policySha256 }, Containers: { proxy: { Name: "/provider-egress-proxy" } } }));
        if (args[0] === "container") return fakeSync(JSON.stringify({ Image: `sha256:${"c".repeat(64)}`, State: { Running: true }, Config: { Labels: { "com.infoapex.ai/provider-egress-policy-sha256": policySha256, "com.infoapex.ai/provider-egress-role": "proxy" } } }));
        if (args[0] === "version") return fakeSync("29.7.2");
        if (args[0] === "image") return fakeSync("sha256:provider");
        if (args[0] === "run" && args.includes("--version")) return fakeSync(args.includes("codex") ? "codex-cli 0.154.0" : "2.1.270 (Claude Code)");
        return fakeSync("provider-output");
      },
      async runAsync() { return fakeBuffered("provider-output"); }
    };

    const environment = new DockerExecutionEnvironment(undefined, dockerRunner);
    const report = environment.doctor(providerProfile);

    assert.equal(report.supported, true);
    assert.equal(report.providerSupported, true);
    assert.equal(report.providerWarnings.length, 0);
    assert.ok(report.capabilities.includes("provider-execution-isolated"));

    const runner = environment.providerProcessRunner?.(providerProfile, "codex");
    assert.ok(runner);
    const result = runner.runSync("codex", ["exec", "--json"], {
      cwd: process.cwd(),
      input: "bounded prompt",
      timeoutMs: 10_000,
      maximumOutputBytes: 4_096,
      shell: false
    });
    assert.equal(result.status, 0);
    const invocation = calls.at(-1);
    assert.ok(invocation);
    assert.equal(invocation.executable, "docker");
    assert.equal(invocation.args[invocation.args.indexOf("--network") + 1], "infoapex-provider-egress");
    assert.ok(invocation.args.includes("HTTP_PROXY=http://provider-egress-proxy:3128"));
    assert.ok(invocation.args.includes("OPENAI_API_KEY"));
    assert.ok(!invocation.args.some((arg) => arg.includes("OPENAI_API_KEY=")));
  });
});

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8"));
}

function fakeSync(stdout: string, status = 0): EngineProcessSyncResult {
  return { pid: 1, output: [stdout, ""], stdout, stderr: "", status, signal: null };
}

function fakeBuffered(stdout: string): BufferedProcessResult {
  return { status: 0, stdout, stderr: "", error: null, timedOut: false, stopReason: null, outputTruncated: false };
}
