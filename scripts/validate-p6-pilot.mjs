#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const preregistration = JSON.parse(readFileSync(join(root, "validation/p6/pilot-preregistration.json"), "utf8"));
const manifestPath = option("--manifest") ?? join(root, "validation/p6/pilot-preregistration.json");
let document;
try {
  document = manifestPath === "-" ? JSON.parse(readFileSync(0, "utf8")) : JSON.parse(readFileSync(resolve(manifestPath), "utf8"));
} catch (error) {
  emit({ status: "BLOCKED", code: "PILOT_MANIFEST_UNREADABLE", findings: [String(error?.message ?? error)] }, 2);
}

const report = validatePilot(document, preregistration);
emit(report, report.status === "PASS" ? 0 : report.status === "NOT_STARTED" || report.status === "IN_PROGRESS" ? 2 : 3);

export function validatePilot(value, frozen) {
  const findings = [];
  if (!value || typeof value !== "object" || Array.isArray(value)) return { status: "BLOCKED", code: "PILOT_MANIFEST_INVALID", findings: ["manifest must be an object"] };
  if (value.schemaVersion !== "1.0" || value.pilotId !== frozen.pilotId) findings.push("manifest identity does not match the frozen preregistration");
  if (value.status === "NOT_STARTED") {
    if (value.verdict !== null || !Array.isArray(value.evidence) || value.evidence.length !== 0) findings.push("NOT_STARTED must have null verdict and empty evidence");
    return findings.length === 0 ? { status: "NOT_STARTED", code: "PILOT_NOT_STARTED", findings: [] } : { status: "BLOCKED", code: "PILOT_BOUNDARY_INVALID", findings };
  }
  if (!["IN_PROGRESS", "PASS", "REJECT", "INCONCLUSIVE"].includes(value.status)) findings.push("status must be IN_PROGRESS, PASS, REJECT, or INCONCLUSIVE");
  if (value.status === "IN_PROGRESS" && value.verdict !== null) findings.push("IN_PROGRESS must have a null verdict");
  if (["PASS", "REJECT", "INCONCLUSIVE"].includes(value.status) && value.verdict !== value.status) findings.push("terminal status and verdict must match");
  const repositories = Array.isArray(value.repositories) ? value.repositories : [];
  const observations = Array.isArray(value.observations) ? value.observations : [];
  const teams = new Set();
  const repositoryIds = new Set();
  for (const repository of repositories) {
    if (!repository || typeof repository !== "object" || typeof repository.path !== "string" || !repository.path || !isAbsolute(repository.path) || repository.fixture !== false || repository.independentFromImplementer !== true || typeof repository.team !== "string" || !repository.team) {
      findings.push("every consumer repository must be absolute, non-fixture, and independently owned");
    } else {
      teams.add(repository.team);
      repositoryIds.add(repository.repositoryId);
    }
  }
  if (new Set(repositories.map((item) => item?.path)).size !== repositories.length) findings.push("consumer repository paths must be unique");
  const paired = observations.filter((item) => item?.paired === true).length;
  const validOutcomes = observations.filter((item) => item?.outcome === "COMPLETED_CORRECTLY" || item?.outcome === "POLICY_REJECTED").length;
  const manual = observations.filter((item) => item?.manualIntervention === true).length;
  const unsafe = observations.filter((item) => item?.secretLeak === true || item?.scopeEscape === true || item?.criticalIncident === true).length;
  if (observations.some((item) => item?.bounded !== true || item?.scopeVerified !== true)) findings.push("every observation must prove bounded scope and scope verification");
  if (observations.some((item) => !repositoryIds.has(item?.repositoryId))) findings.push("every observation must reference a registered consumer repository");
  if (unsafe > 0 || (Array.isArray(value.stopConditions) && value.stopConditions.length > 0)) findings.push("stop condition or critical safety failure is present");
  const days = elapsedDays(value.checkpoints?.firstAt, value.checkpoints?.lastAt);
  const completeScope = repositories.length >= frozen.scope.consumerRepositories && teams.size >= frozen.scope.independentUsersOrTeams && observations.length >= frozen.scope.boundedTasks && paired >= frozen.scope.pairedEvaluationTasks && days >= frozen.scope.minimumCalendarDays;
  if (value.status === "PASS") {
    if (!completeScope) findings.push("PASS requires the complete frozen pilot scope and 30-day window");
    if (!["upgrade", "rollback", "incidentDrill", "restore"].every((key) => value.scenarios?.[key] === true)) findings.push("PASS requires upgrade, rollback, incident drill, and restore evidence");
    if (observations.length === 0 || (validOutcomes / observations.length) * 100 < frozen.acceptance.validTaskCorrectOrPolicyRejectedPercentMin) findings.push("valid task outcome rate is below the frozen threshold");
    if (observations.some((item) => item?.scopeVerified !== true)) findings.push("scope verification is below 100 percent");
    if (observations.length > 0 && (manual / observations.length) * 100 > frozen.acceptance.unplannedManualInterventionPercentMax) findings.push("manual intervention rate is above the frozen threshold");
    if (typeof value.quickstartUnaidedPercent !== "number" || value.quickstartUnaidedPercent < frozen.acceptance.quickstartUnaidedPercentMin) findings.push("quickstart unaided rate is below the frozen threshold");
  }
  return findings.length === 0 ? { status: value.status, code: `PILOT_${value.status}`, findings: [] } : { status: value.status === "PASS" ? "BLOCKED" : value.status, code: value.status === "PASS" ? "PILOT_PASS_UNPROVEN" : "PILOT_EVIDENCE_INVALID", findings };
}

function elapsedDays(first, last) {
  const start = Date.parse(typeof first === "string" ? first : "");
  const end = Date.parse(typeof last === "string" ? last : "");
  return Number.isFinite(start) && Number.isFinite(end) && end >= start ? (end - start) / 86_400_000 : -1;
}
function option(name) { const index = process.argv.indexOf(name); return index < 0 ? null : process.argv[index + 1] ?? null; }
function emit(value, code) { console.log(JSON.stringify({ schemaVersion: "1.0", ...value }, null, 2)); process.exit(code); }
