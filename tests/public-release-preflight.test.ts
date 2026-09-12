import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { test } from "node:test";

type Check = { id: string; status: string };
type PreflightReport = {
  status: string;
  code: string;
  publicationAllowed: boolean;
  checks: Check[];
};

function runPreflight(...args: string[]) {
  try {
    const stdout = execFileSync(process.execPath, [resolve("scripts/public-release-preflight.mjs"), ...args], {
      cwd: process.cwd(),
      encoding: "utf8"
    });
    return { exitCode: 0, report: JSON.parse(stdout) as PreflightReport };
  } catch (error) {
    const child = error as { status?: number; stdout?: string };
    return {
      exitCode: child.status ?? -1,
      report: JSON.parse(child.stdout ?? "{}") as PreflightReport
    };
  }
}

test("public preflight remains fail-closed during local preparation", () => {
  const result = runPreflight("--skip-tag-check", "--candidate", "v1.0.0");

  assert.equal(result.exitCode, 2);
  assert.equal(result.report.status, "BLOCKED");
  assert.equal(result.report.code, "PUBLIC_RELEASE_BLOCKED");
  assert.equal(result.report.publicationAllowed, false);
  assert.equal(result.report.checks.find((check) => check.id === "tag-boundary")?.status, "SKIPPED");
  assert.equal(result.report.checks.find((check) => check.id === "maintainer-go")?.status, "BLOCKED");
  assert.equal(result.report.checks.find((check) => check.id === "isolation-backend")?.status, "BLOCKED");
});
