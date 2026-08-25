import { readFileSync } from "node:fs";

const text = readFileSync("docs/adr/0003-fallback-ownership.md", "utf8");

const requiredMatches = [
  { pattern: /^# ADR-0003/m, label: "H1 heading '# ADR-0003...'" },
  { pattern: /accepted/i, label: "'accepted' status" },
  { pattern: /scope violation/i, label: "'scope violation'" }
];

const requiredSubstrings = ["POLICY_FAILURE", "--fallback-engine"];

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
