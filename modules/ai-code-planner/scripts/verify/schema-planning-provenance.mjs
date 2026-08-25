import { readFileSync } from "node:fs";

const raw = readFileSync("schemas/planning-provenance.schema.json", "utf8");
const schema = JSON.parse(raw);

let ok = true;

function check(condition, label) {
  if (!condition) {
    console.error(`failed: ${label}`);
    ok = false;
  }
}

const required = schema.required ?? [];
for (const field of [
  "mode",
  "panelMembers",
  "roundsUsed",
  "roundsAllowed",
  "outcome",
  "findings",
  "planningCostUsd",
  "planningDurationSec"
]) {
  check(required.includes(field), `required includes ${field}`);
}

const outcomeEnum = schema.properties?.outcome?.enum ?? [];
check(outcomeEnum.includes("CONSENSUS_WITH_DISSENT"), "outcome enum includes CONSENSUS_WITH_DISSENT");
check(outcomeEnum.includes("HUMAN_DECISION_REQUIRED"), "outcome enum includes HUMAN_DECISION_REQUIRED");
check(outcomeEnum.includes("INVALID_PLAN"), "outcome enum includes INVALID_PLAN");

process.exit(ok ? 0 : 1);
