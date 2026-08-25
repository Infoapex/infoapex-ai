import { readFileSync } from "node:fs";

const text = readFileSync("docs/adr/0004-agent-runner.md", "utf8");

const requiredMatches = [
  { pattern: /^# ADR-0004/m, label: "H1 heading '# ADR-0004...'" },
  { pattern: /accepted/i, label: "'accepted' status" },
  { pattern: /own adapters/i, label: "'own adapters'" }
];

const requiredSubstrings = ["planningProvenance", "routing-outcome"];

let ok = true;

for (const { pattern, label } of requiredMatches) {
  if (!pattern.test(text)) {
    console.error(`missing: ${label}`);
    ok = false;
  }
}

for (const substring of requiredSubstrings) {
  if (!text.includes(substring)) {
    console.error(`missing substring: ${substring}`);
    ok = false;
  }
}

process.exit(ok ? 0 : 1);
