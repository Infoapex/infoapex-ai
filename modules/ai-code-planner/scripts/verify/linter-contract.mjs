import { readFileSync } from "node:fs";

const text = readFileSync("docs/LINTER-CONTRACT.md", "utf8");

const requiredMatches = [
  { pattern: /Projection to worker v1\.0/, label: "section 'Projection to worker v1.0'" },
  { pattern: /CYCLIC_DEPENDENCY|acyclic/i, label: "cyclic-dependency check documented" }
];

const requiredSubstrings = ["projectionWarnings", "criterionId", "evidenceContract"];

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
