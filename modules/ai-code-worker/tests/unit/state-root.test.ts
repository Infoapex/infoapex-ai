import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { resolveStateRoot } from "../../src/state/state-root.js";

describe("state root resolver", () => {
  it("places default Windows state outside the repository under LOCALAPPDATA", () => {
    const resolved = resolveStateRoot({
      repoRoot: "C:/work/product",
      env: { LOCALAPPDATA: "C:/Users/alex/AppData/Local" },
      platform: "win32",
      homeDirectory: "C:/Users/alex"
    });

    assert.equal(resolved.source, "default");
    assert.equal(resolved.insideRepository, false);
    assert.match(resolved.path.replaceAll("\\", "/"), /^C:\/Users\/alex\/AppData\/Local\/ai-code-worker\/repos\/[a-f0-9]{16}$/);
  });

  it("flags configured state roots that live inside the repository", () => {
    const resolved = resolveStateRoot({
      repoRoot: "/repo/product",
      configuredStateRoot: ".ai-code-worker/runs",
      platform: "linux",
      homeDirectory: "/home/alex",
      env: {}
    });

    assert.equal(resolved.source, "configured");
    assert.equal(resolved.insideRepository, true);
  });
});
