import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { signOtelCandidateAuthorization, validateOtelCandidateAuthorization } from "../src/p5/authorization.js";
import { loadOtelCandidateSuite, OTEL_CANDIDATE_SUITE_ID } from "../src/p5/otel-candidate.js";

test("the P5 OpenTelemetry suite freezes exactly two matched arms and twenty invocations", () => {
  const suiteRoot = fileURLToPath(new URL("../../../../validation/benchmark/pilot/", import.meta.url));
  const suite = loadOtelCandidateSuite(suiteRoot);
  assert.equal(suite.value.id, OTEL_CANDIDATE_SUITE_ID);
  assert.deepEqual((suite.value.arms as readonly { id: string; model: string; effort: string }[]).map((arm) => [arm.id, arm.model, arm.effort]), [["full-icm", "gpt-5.6-luna", "medium"], ["candidate", "gpt-5.6-luna", "medium"]]);
  assert.equal((suite.value.budgets as { maximumInvocations: number }).maximumInvocations, 20);
});

test("P5 authorization is signature-bound to experiment, hypothesis, scope, and exact budget", () => {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519", { privateKeyEncoding: { type: "pkcs8", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } });
  const now = new Date("2026-09-04T10:00:00.000Z");
  const payload = { experimentId: "p5-otel-test", experimentHash: "a".repeat(64), hypothesisHash: "b".repeat(64), provider: "codex" as const, maximumInvocations: 20 as const, scope: "P5-OTEL" as const, approvedBy: "unit-test", issuedAt: new Date(now.getTime() - 60_000).toISOString(), expiresAt: new Date(now.getTime() + 60_000).toISOString() };
  const signed = signOtelCandidateAuthorization(payload, privateKey, publicKey);
  const path = join(mkdtempSync(join(tmpdir(), "p5-otel-authorization-")), "authorization.json");
  writeFileSync(path, `${JSON.stringify(signed)}\n`, "utf8");
  assert.equal(validateOtelCandidateAuthorization(path, { experimentId: payload.experimentId, experimentHash: payload.experimentHash, hypothesisHash: payload.hypothesisHash, now }).payload.maximumInvocations, 20);
  assert.throws(() => validateOtelCandidateAuthorization(path, { experimentId: payload.experimentId, experimentHash: payload.experimentHash, hypothesisHash: "c".repeat(64), now }), /does not match/u);
});
