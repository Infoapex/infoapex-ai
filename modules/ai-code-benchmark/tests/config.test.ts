import assert from "node:assert/strict";
import test from "node:test";
import { defaultConfig, parseConfig } from "../src/config.js";

test("default configuration is accepted and disables privileged capabilities", () => {
  const config = parseConfig(defaultConfig());
  assert.equal(config.stateRoot, null);
  assert.equal(config.capabilities.liveExecution, false);
  assert.deepEqual(config.commands.infoapex, ["infoapex-ai"]);
});

test("configuration rejects unknown fields and enabled capabilities", () => {
  assert.throws(() => parseConfig({ ...defaultConfig(), unexpected: true }), /unknown properties/);
  assert.throws(() => parseConfig({ ...defaultConfig(), capabilities: { ...defaultConfig().capabilities, publish: true } }), /must remain false/);
  assert.throws(() => parseConfig({ ...defaultConfig(), capabilities: { ...defaultConfig().capabilities, liveExecution: true } }), /complete explicit BENCH-09/);
});

test("explicit live capability requires the exact bounded trusted-fixture pilot contract", () => {
  const live = parseConfig({
    ...defaultConfig(),
    capabilities: { ...defaultConfig().capabilities, liveExecution: true },
    pilot: {
      schemaVersion: "bench-09-live.v1", trustedFixtureOnly: true, maximumInvocations: 30, equalBudgets: true,
      sharedConfigHash: "a".repeat(64),
      arms: {
        "orchestrated-no-icm": { contextProvider: "none", contextPackageMode: "off" },
        "full-icm": { contextProvider: "ai-code-control", contextPackageMode: "enforce" }
      }
    }
  });
  assert.equal(live.capabilities.liveExecution, true);
  assert.throws(() => parseConfig({ ...live, pilot: { ...live.pilot, trustedFixtureOnly: false } }), /trusted-fixture/);
});
