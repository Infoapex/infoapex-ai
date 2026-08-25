import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { createLease, evaluateLease, readLease, writeLease } from "../../src/persistence/lease.js";

const tempRoots: string[] = [];

after(() => {
  for (const root of tempRoots) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("run lease", () => {
  it("writes and reads coordinator lease identity", () => {
    const path = leasePath();
    const lease = createLease("run-1", "coordinator-1", "2026-08-01T10:00:00Z");

    writeLease(path, lease);

    assert.deepEqual(readLease(path), lease);
    assert.equal(evaluateLease(path, "2026-08-01T10:00:30Z", 60000).state, "active");
    assert.equal(evaluateLease(path, "2026-08-01T10:02:00Z", 60000).state, "expired");
  });

  it("reports missing leases without creating state", () => {
    assert.equal(evaluateLease(leasePath(), "2026-08-01T10:00:00Z", 60000).state, "missing");
  });
});

function leasePath(): string {
  const root = mkdtempSync(join(tmpdir(), "aicw-lease-"));
  tempRoots.push(root);

  return join(root, "lease.json");
}
