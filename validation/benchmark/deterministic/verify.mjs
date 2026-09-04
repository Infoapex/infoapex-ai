#!/usr/bin/env node

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const positionalOutput = process.argv.slice(2).find((value) => !value.startsWith("--"));
const output = resolve(option("--output") ?? optionEquals("--output") ?? positionalOutput ?? process.env.BENCH_D_OUTPUT ?? resolve(root, "validation", "benchmark", "deterministic", "artifacts"));
const reportPath = resolve(output, "report.json");
const rawPath = resolve(output, "raw", "observations.jsonl");
if (!existsSync(reportPath) || !existsSync(rawPath) || !existsSync(resolve(output, "report.md"))) fail("missing canonical BENCH-D artifact");
const report = JSON.parse(readFileSync(reportPath, "utf8"));
const lines = readFileSync(rawPath, "utf8").split(/\r?\n/u).filter(Boolean);
if (report.benchmark !== "BENCH-D" || report.schemaVersion !== "1.0") fail("invalid report identity");
if (report.counts?.tasks !== 12 || report.counts?.arms !== 3 || report.counts?.observations !== 36) fail("BENCH-D must contain exactly 12 × 3 observations");
if (lines.length !== 36) fail("raw observation count is not 36");
if (JSON.stringify(report.scoreOrdering) !== JSON.stringify(["C", "B", "A"])) fail("expected score ordering C > B > A is missing");
if (report.mutation?.precision !== 1 || report.mutation?.recall !== 1) fail("mutation precision/recall gate failed");
const all = readFileSync(resolve(output, "raw", "manifest.json"), "utf8") + readFileSync(rawPath, "utf8") + readFileSync(reportPath, "utf8");
if (/super-secret|supersecret|api[_-]?key\s*[:=]\s*[^\s"}]+/iu.test(all)) fail("secret-like material leaked into artifacts");
if (report.reproducibility?.canonicalHash !== hash(report.reproducibility?.canonicalReport)) fail("report canonical hash is invalid");
console.log(JSON.stringify({ status: "PASS", benchmark: "BENCH-D", tasks: 12, arms: 3, observations: 36, canonicalReportSha256: sha256(canonical(report)), reportFileSha256: sha256(readFileSync(reportPath)), rawSha256: sha256(readFileSync(rawPath)) }));

function option(name) {
  const i = process.argv.indexOf(name);
  if (i < 0) return null;
  const value = process.argv[i + 1];
  if (!value || value.startsWith("--")) fail(`missing ${name}`);
  return value;
}
function optionEquals(name) { const value = process.argv.find((item) => item.startsWith(`${name}=`)); return value?.slice(name.length + 1) || null; }
function hash(value) { return createHash("sha256").update(canonical(value)).digest("hex"); }
function sha256(value) { return createHash("sha256").update(value).digest("hex"); }
function canonical(value) { return JSON.stringify(normalize(value)); }
function normalize(value) { if (typeof value === "string") return value.replace(/\r\n?/gu, "\n"); if (Array.isArray(value)) return value.map(normalize); if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map((key) => [key, normalize(value[key])])); return value; }
function fail(message) { console.error(`BENCH-D VERIFY FAILED: ${message}`); process.exit(1); }
