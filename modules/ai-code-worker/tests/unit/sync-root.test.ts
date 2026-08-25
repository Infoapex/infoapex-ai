import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { detectSyncRoot, evaluateSyncRootPolicy } from "../../src/git/sync-root.js";

describe("sync root policy", () => {
  it("detects Git common directories under OneDrive from environment roots", () => {
    const detection = detectSyncRoot("C:/Users/alex/OneDrive/Product/.git", {
      OneDrive: "C:/Users/alex/OneDrive"
    });

    assert.deepEqual(detection, {
      kind: "onedrive",
      root: "C:/Users/alex/OneDrive",
      evidence: "OneDrive"
    });
  });

  it("blocks parallel writers under sync roots", () => {
    const result = evaluateSyncRootPolicy({
      gitCommonDir: "C:/Users/alex/OneDrive/Product/.git",
      maximumParallelWriters: 2,
      policy: {
        sequentialWriter: "warn",
        parallelWriters: "block"
      },
      env: {
        OneDrive: "C:/Users/alex/OneDrive"
      }
    });

    assert.equal(result.writerMode, "parallel");
    assert.equal(result.verdict, "block");
    assert.equal(result.detection?.kind, "onedrive");
  });

  it("warns sequential writers under sync roots when configured", () => {
    const result = evaluateSyncRootPolicy({
      gitCommonDir: "/Users/alex/Dropbox/Product/.git",
      maximumParallelWriters: 1,
      policy: {
        sequentialWriter: "warn",
        parallelWriters: "block"
      },
      env: {}
    });

    assert.equal(result.writerMode, "sequential");
    assert.equal(result.verdict, "warn");
    assert.equal(result.detection?.kind, "dropbox");
  });
});
