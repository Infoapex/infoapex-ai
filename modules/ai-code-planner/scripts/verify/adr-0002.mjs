import { readFileSync } from "node:fs";

const text = readFileSync("docs/adr/0002-plan-and-manifest-ownership.md", "utf8");

const requiredMatches = [
  { pattern: /^# ADR-0002/m, label: "H1 heading '# ADR-0002...'" },
  { pattern: /accepted/i, label: "'accepted' status" },
  { pattern: /runId/, label: "runId" },
  { pattern: /graphVersion/, label: "graphVersion" }
];

const requiredSubstrings = ["plan.sha256", "base.commit"];

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
