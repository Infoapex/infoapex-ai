import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { versionMatches, versionMatchesAny } from "../../src/engines/version-match.js";

describe("version-match", () => {
  it("matches an exact version string", () => {
    assert.equal(versionMatches("2.1.177", "2.1.177"), true);
    assert.equal(versionMatches("2.1.178", "2.1.177"), false);
  });

  it("matches a .x suffix range as a prefix", () => {
    assert.equal(versionMatches("2.1.177", "2.1.x"), true);
    assert.equal(versionMatches("2.2.0", "2.1.x"), false);
  });

  it("matches any of several ranges", () => {
    assert.equal(versionMatchesAny("2.1.177", ["0.146.x", "2.1.x"]), true);
    assert.equal(versionMatchesAny("3.0.0", ["0.146.x", "2.1.x"]), false);
  });
});
