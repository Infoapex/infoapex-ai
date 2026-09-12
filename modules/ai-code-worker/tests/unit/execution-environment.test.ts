import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { DockerExecutionEnvironment, FakeExecutionEnvironment, LocalIsolatedExecutionEnvironment } from "../../src/execution/environment.js";
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
});

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8"));
}
