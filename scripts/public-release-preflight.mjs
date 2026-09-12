#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const candidate = option("--candidate") ?? "v1.0.0";
const decisionRelative = option("--decision") ?? "validation/p6/solo-go-no-go.json";
const zipRelative = option("--zip") ?? `dist-release/infoapex-ai-${candidate}.zip`;
const sbomRelative = option("--sbom") ?? `dist-release/infoapex-ai-${candidate}.cdx.json`;
const requireTag = !process.argv.includes("--skip-tag-check");
const checks = [];

check("candidate-format", /^v[0-9]+\.[0-9]+\.[0-9]+$/.test(candidate), "public release candidate must be a stable vX.Y.Z tag");
const packageJson = readJson("package.json");
check("package-version", packageJson?.version === candidate.slice(1), `package version must equal ${candidate.slice(1)}`);
check("tracked-tree-clean", gitOk(["diff", "--quiet", "HEAD", "--"]), "all release inputs must be committed");

const head = git(["rev-parse", "HEAD"]);
let tagCommit = null;
if (requireTag) {
  tagCommit = git(["rev-parse", `${candidate}^{commit}`]);
  check("tag-boundary", Boolean(tagCommit) && tagCommit === head, "the checked-out commit must be the exact candidate tag target");
} else {
  checks.push({ id: "tag-boundary", status: "SKIPPED", detail: "local preparation mode; publication workflow must enforce the tag" });
}

const decisionPath = safePath(decisionRelative);
const decision = readJson(decisionRelative);
const decisionSchema = readJson("validation/p6/solo-go-no-go.schema.json");
const ajv = new Ajv2020({ strict: false });
addFormats(ajv);
const validateDecision = decisionSchema ? ajv.compile(decisionSchema) : () => false;
const decisionValid = Boolean(decision && validateDecision(decision)) &&
  decision.candidate === candidate &&
  decision.decision === "GO" &&
  decision.profile === "solo-maintainer";
check("maintainer-go", decisionValid && existsSync(decisionPath), "an explicit, committed solo-maintainer GO decision is required");

const zipPath = safePath(zipRelative);
const sbomPath = safePath(sbomRelative);
const checksumPath = `${zipPath}.sha256`;
const manifestPath = `${zipPath}.manifest.json`;
const artifactFilesPresent = [zipPath, sbomPath, checksumPath, manifestPath].every(existsSync);
check("artifact-presence", artifactFilesPresent, "ZIP, checksum, provenance manifest, and SBOM are required");
if (artifactFilesPresent) {
  try {
    const actualSha = createHash("sha256").update(readFileSync(zipPath)).digest("hex");
    const declaredSha = readFileSync(checksumPath, "utf8").trim().split(/\s+/)[0];
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    const sbom = JSON.parse(readFileSync(sbomPath, "utf8"));
    const provenanceMatches = manifest.commit === head && manifest.sha256 === actualSha;
    const sbomValid = sbom.bomFormat === "CycloneDX" && Array.isArray(sbom.components) && sbom.components.length > 0;
    check("artifact-integrity", actualSha === declaredSha && provenanceMatches && sbomValid, "checksum, provenance, and SBOM must match the tagged commit");
  } catch (error) {
    check("artifact-integrity", false, error instanceof Error ? error.message : String(error));
  }
}

const releaseWorkflow = readText(".github/workflows/release.yml");
const workflowValid = releaseWorkflow.includes("actions/attest@v4") &&
  releaseWorkflow.includes("sbom-path:") &&
  releaseWorkflow.includes("gh release create") &&
  releaseWorkflow.includes("--verify-tag") &&
  releaseWorkflow.includes("visibility != 'public'") &&
  releaseWorkflow.includes("public-release-preflight");
check("publication-workflow", workflowValid, "the public workflow must attest, verify the tag, require public visibility, and call this guard");

const allChecksPass = checks.every((entry) => entry.status === "PASS" || entry.status === "SKIPPED");
const tagSatisfied = !requireTag || checks.some((entry) => entry.id === "tag-boundary" && entry.status === "PASS");
const status = requireTag && allChecksPass && tagSatisfied;
const result = {
  schemaVersion: "1.0",
  profile: "solo-maintainer",
  candidate,
  status: status ? "PASS" : "BLOCKED",
  code: status ? "PUBLIC_RELEASE_READY" : (!requireTag && allChecksPass ? "PUBLIC_RELEASE_PREPARED_NO_TAG" : "PUBLIC_RELEASE_BLOCKED"),
  publicationAllowed: status,
  checks,
  commit: head,
  commitSha256: head ? createHash("sha256").update(head).digest("hex") : null
};
console.log(JSON.stringify(result, null, 2));
process.exitCode = status ? 0 : 2;

function check(id, pass, detail) { checks.push({ id, status: pass ? "PASS" : "BLOCKED", detail }); }
function option(name) { const index = process.argv.indexOf(name); return index < 0 ? null : process.argv[index + 1] ?? null; }
function safePath(value) {
  const absolute = resolve(root, value);
  const rel = relative(root, absolute);
  if (isAbsolute(rel) || rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) || rel === "..") throw new Error(`path escapes repository: ${value}`);
  return absolute;
}
function readJson(value) { try { return JSON.parse(readFileSync(safePath(value), "utf8")); } catch { return null; } }
function readText(value) { try { return readFileSync(safePath(value), "utf8"); } catch { return ""; } }
function git(args) { try { return execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim(); } catch { return null; } }
function gitOk(args) { return git(args) !== null; }
