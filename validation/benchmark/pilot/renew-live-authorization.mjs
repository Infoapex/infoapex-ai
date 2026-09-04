#!/usr/bin/env node
import { generateKeyPairSync } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = resolve(fileURLToPath(new URL(".", import.meta.url)));
const bundleRoot = resolve(here, "../../..");
const moduleRoot = join(bundleRoot, "modules", "ai-code-benchmark");
const experimentPath = resolve(requiredOption("--experiment"));
const durationHours = Number(option("--duration-hours") ?? "4");
const approvedBy = option("--approved-by") ?? "explicit-user-request-continuation";

if (!existsSync(experimentPath)) throw new Error(`Experiment does not exist: ${experimentPath}`);
if (!Number.isFinite(durationHours) || durationHours <= 0 || durationHours > 8) {
  throw new Error("--duration-hours must be greater than 0 and at most 8.");
}

const experiment = JSON.parse(readFileSync(experimentPath, "utf8"));
if (typeof experiment.id !== "string" || typeof experiment.experimentHash !== "string") {
  throw new Error("Frozen experiment is missing its id or experimentHash.");
}

const authorization = await import(pathToFileURL(join(moduleRoot, "dist", "src", "pilot", "authorization.js")).href);
const { privateKey, publicKey } = generateKeyPairSync("ed25519", {
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" }
});
const issuedAt = new Date();
const payload = {
  experimentId: experiment.id,
  experimentHash: experiment.experimentHash,
  provider: "codex",
  maximumInvocations: 30,
  scope: "BENCH-09",
  approvedBy,
  issuedAt: issuedAt.toISOString(),
  expiresAt: new Date(issuedAt.getTime() + durationHours * 60 * 60 * 1000).toISOString()
};
const signed = authorization.signPilotAuthorization(payload, privateKey, publicKey);
const stamp = issuedAt.toISOString().replace(/[-:]/gu, "").replace(/\.\d{3}Z$/u, "Z");
const authorizationPath = resolve(option("--out") ?? join(dirname(experimentPath), `authorization-continuation-${stamp}.json`));

if (existsSync(authorizationPath)) throw new Error(`Refusing to overwrite authorization: ${authorizationPath}`);
writeFileSync(authorizationPath, `${JSON.stringify(signed, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
authorization.validatePilotAuthorization(authorizationPath, {
  experimentId: experiment.id,
  experimentHash: experiment.experimentHash,
  maximumInvocations: 30,
  provider: "codex"
});

console.log(JSON.stringify({
  status: "PASS",
  experiment: basename(experimentPath),
  experimentId: experiment.id,
  experimentHash: experiment.experimentHash,
  authorizationPath,
  issuedAt: payload.issuedAt,
  expiresAt: payload.expiresAt
}, null, 2));

function option(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] ?? null : null;
}

function requiredOption(name) {
  const value = option(name);
  if (!value) throw new Error(`${name} is required.`);
  return value;
}
