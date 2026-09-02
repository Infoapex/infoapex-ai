import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// P3, step 1: "Construirea ZIP-ului din commituri fixate" (docs/plans/INFOAPEX-AI-ROADMAP-P0-P5.md
// section 7). Uses `git archive`, not a directory copy: it reads directly from the git object
// database at the given ref, so the result is *exactly* what is committed - no dist/,
// node_modules/, uncommitted edits, or stray local files can leak in, regardless of what the
// working tree currently looks like. That is the literal mechanism behind the roadmap's "fără
// dependență accidentală de directoarele locale de dezvoltare" requirement, not a policy this
// script has to enforce by hand.

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ref = option("--ref") ?? "HEAD";
const outputPath = resolve(root, option("--out") ?? join("dist-release", "pending.zip"));

// `^{commit}` dereferences an annotated tag to the commit it points at - without it,
// `git rev-parse <annotated-tag>` returns the tag OBJECT's own sha, not the commit's
// (found while cutting v0.1.0: the manifest recorded the tag object, not the commit).
const commit = git(["rev-parse", `${ref}^{commit}`]).trim();
const isDirty = git(["status", "--porcelain"]).trim().length > 0;
if (ref === "HEAD" && isDirty && !process.argv.includes("--allow-dirty")) {
  console.error(JSON.stringify({
    status: "BLOCKED",
    code: "WORKING_TREE_DIRTY",
    message: "HEAD has uncommitted changes. `git archive` only ever packages the committed " +
      "tree, so this would silently produce a ZIP that omits your pending edits - commit first, " +
      "archive a specific --ref, or pass --allow-dirty to acknowledge this on purpose."
  }, null, 2));
  process.exitCode = 2;
  process.exit();
}

const finalOutputPath = outputPath.includes("pending.zip")
  ? join(dirname(outputPath), `infoapex-ai-${commit.slice(0, 12)}.zip`)
  : outputPath;

mkdirSync(dirname(finalOutputPath), { recursive: true });
git(["archive", "--format=zip", "-o", finalOutputPath, ref]);

const sha256 = createHash("sha256").update(readFileSync(finalOutputPath)).digest("hex");
writeFileSync(`${finalOutputPath}.sha256`, `${sha256}  ${finalOutputPath.split(/[/\\]/).pop()}\n`, "utf8");

const manifest = {
  schemaVersion: "1.0",
  ref,
  commit,
  createdAt: new Date().toISOString(),
  zipPath: finalOutputPath,
  sha256
};
const manifestPath = `${finalOutputPath}.manifest.json`;
writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

console.log(JSON.stringify({ status: "DONE", ...manifest, manifestPath }, null, 2));

function git(args) {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" });
}

function option(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] ?? null : null;
}
