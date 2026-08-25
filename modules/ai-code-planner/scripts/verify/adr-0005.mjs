import { readFileSync } from "node:fs";

const text = readFileSync("docs/adr/0005-worker-compatibility-matrix.md", "utf8");

const requiredMatches = [
  { pattern: /^# ADR-0005/m, label: "H1 heading '# ADR-0005...'" },
  { pattern: /accepted/i, label: "'accepted' status" },
  { pattern: /compatibility review/i, label: "'compatibility review'" },
  { pattern: /\|/, label: "a Markdown table (contains '|')" }
];

const requiredSubstrings = ["d23d5a0"];

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
