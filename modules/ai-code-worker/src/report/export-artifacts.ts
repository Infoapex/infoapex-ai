import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { git } from "../git/diff.js";
import { sha256 } from "../manifest/normalize.js";
import { prepareReportText, redactText } from "../runner/redaction.js";
import type { RepairAttempt } from "../repair/repair-attempt.js";
import type { RepairBudget } from "../repair/repair-budget.js";
import type { RepairTask } from "../repair/repair-task.js";
import type { IndependentReviewResult } from "../review/independent-review.js";
import { SchemaRegistry } from "../schema/json-schema.js";

export interface ExportPatchInput {
  readonly repositoryPath: string;
  readonly baseCommit: string;
  readonly headCommit: string;
}

export interface ExportedPatch {
  readonly patchText: string;
  readonly sha256: string;
  readonly baseCommit: string;
  readonly headCommit: string;
}

export type ExportPatchErrorCode = "SECRET_DETECTED";

export class ExportPatchError extends Error {
  constructor(
    readonly code: ExportPatchErrorCode,
    message: string
  ) {
    super(message);
    this.name = "ExportPatchError";
  }
}

/**
 * A `git diff`-format patch between the run's base commit and its final
 * result, appliable outside the worker's own worktrees/branches via
 * `git apply`. This is read-only against the repository (no ref is moved).
 *
 * A patch must stay byte-exact to remain appliable, so unlike free-text
 * reports it is never substitution-redacted - if it looks like it contains
 * a secret, the export fails closed (ExportPatchError) instead of silently
 * shipping the secret or corrupting the diff. "Raw transcripts, secrets,
 * and unredacted engine output must not be persisted in repo artifacts"
 * (Phase 3 guardrails) leaves no safe middle ground here.
 */
export function exportPatch(input: ExportPatchInput): ExportedPatch {
  const patchText = git(["diff", "--binary", input.baseCommit, input.headCommit], input.repositoryPath);

  if (redactText(patchText).redacted) {
    throw new ExportPatchError(
      "SECRET_DETECTED",
      `Refusing to export a patch between ${input.baseCommit} and ${input.headCommit}: it contains secret-looking content. Remove the secret from history before exporting, or export the affected paths manually after review.`
    );
  }

  return {
    patchText,
    sha256: sha256(patchText),
    baseCommit: input.baseCommit,
    headCommit: input.headCommit
  };
}

export function writePatchFile(runRoot: string, patch: ExportedPatch): string {
  const exportDir = join(runRoot, "export");
  mkdirSync(exportDir, { recursive: true });

  const path = join(exportDir, "patch.diff");
  writeFileSync(path, patch.patchText.endsWith("\n") || patch.patchText === "" ? patch.patchText : `${patch.patchText}\n`, "utf8");

  return path;
}

export interface ExportBranchInput {
  readonly repositoryPath: string;
  readonly branchName: string;
  readonly headCommit: string;
}

export interface ExportedBranch {
  readonly branchName: string;
  readonly commit: string;
}

export type ExportBranchErrorCode = "BRANCH_IS_CHECKED_OUT";

export class ExportBranchError extends Error {
  constructor(
    readonly code: ExportBranchErrorCode,
    message: string
  ) {
    super(message);
    this.name = "ExportBranchError";
  }
}

/**
 * IMPLEMENTATION-PLAN.md §11.5: "the user's branch is not moved until DONE,
 * and not even then without the explicit apply/export command." This is
 * that explicit command - it force-creates or moves a named branch ref to
 * the run's result commit, and refuses to touch whichever branch is
 * currently checked out (moving a checked-out branch's ref without also
 * updating the working tree leaves the repository in a confusing,
 * out-of-sync state - the user must `git switch` to it themselves).
 */
export function exportBranch(input: ExportBranchInput): ExportedBranch {
  const currentBranch = git(["rev-parse", "--abbrev-ref", "HEAD"], input.repositoryPath);

  if (currentBranch === input.branchName) {
    throw new ExportBranchError(
      "BRANCH_IS_CHECKED_OUT",
      `Refusing to move branch "${input.branchName}" because it is the currently checked-out branch in ${input.repositoryPath}. Switch away from it first, or export under a different branch name.`
    );
  }

  git(["branch", "-f", input.branchName, input.headCommit], input.repositoryPath);

  return { branchName: input.branchName, commit: input.headCommit };
}

export interface WriteBlockedReportInput {
  readonly runRoot: string;
  readonly runId: string;
  readonly cause: string;
  readonly lastSafeState: string;
  readonly evidencePaths: readonly string[];
  readonly resumeInstructions: string;
}

/**
 * IMPLEMENTATION-PLAN.md §10.2 lists BLOCKED.md as a top-level run artifact,
 * and the Phase 3 guardrails require it to carry "cause, last safe state,
 * evidence, and resume instructions" - none of which run-report.md
 * currently structures this explicitly (it has a single free-text
 * blockedReason). This is a distinct, purpose-built report, not a
 * replacement for run-report.md.
 */
export interface WriteBlockedReportResult {
  readonly path: string;
  readonly redacted: boolean;
  readonly truncated: boolean;
}

export function writeBlockedReport(input: WriteBlockedReportInput): WriteBlockedReportResult {
  const path = join(input.runRoot, "BLOCKED.md");
  const evidence = input.evidencePaths.length === 0 ? "- No evidence artifacts recorded." : input.evidencePaths.map((entry) => `- ${entry}`).join("\n");
  const cause = prepareReportText(input.cause);
  const lastSafeState = prepareReportText(input.lastSafeState);
  const resumeInstructions = prepareReportText(input.resumeInstructions);

  writeFileSync(
    path,
    `# ai-code-worker Run BLOCKED

- Run ID: ${input.runId}

## Cause

${cause.text}

## Last Safe State

${lastSafeState.text}

## Evidence

${evidence}

## Resume Instructions

${resumeInstructions.text}
`,
    "utf8"
  );

  return {
    path,
    redacted: cause.redacted || lastSafeState.redacted || resumeInstructions.redacted,
    truncated: cause.truncated || lastSafeState.truncated || resumeInstructions.truncated
  };
}

export interface WriteRepairEvidenceReportInput {
  readonly runRoot: string;
  readonly runId: string;
  readonly budget: RepairBudget;
  readonly tasks: readonly RepairTask[];
  readonly attempts: readonly RepairAttempt[];
}

/** Human-readable audit trail over the repair-cycle records from stages 1/3/4. */
export function writeRepairEvidenceReport(input: WriteRepairEvidenceReportInput): string {
  const path = join(input.runRoot, "repairs", "repair-evidence.md");
  mkdirSync(join(input.runRoot, "repairs"), { recursive: true });

  const tasksById = new Map(input.tasks.map((task) => [task.id, task]));
  const attemptRows =
    input.attempts.length === 0
      ? "- No repair attempts recorded."
      : input.attempts
          .map((attempt) => {
            const task = tasksById.get(attempt.repairTaskId);
            const scope = task ? task.allowedPaths.join(", ") : "unknown";
            return `- cycle ${attempt.cycle}, task ${attempt.repairTaskId} (scope: ${scope}): ${attempt.outcome ?? "PENDING"}${attempt.commit ? ` at ${attempt.commit}` : ""}`;
          })
          .join("\n");

  writeFileSync(
    path,
    `# ai-code-worker Repair Evidence

- Run ID: ${input.runId}
- Repair cycles consumed: ${input.budget.consumedCycles} / ${input.budget.maximumRepairCycles}
- Stop reason: ${input.budget.stopReason ?? "none (resolved)"}

## Attempts

${attemptRows}
`,
    "utf8"
  );

  return path;
}

export interface WriteRedactedHandoffInput {
  readonly repositoryPath: string;
  readonly runId: string;
  readonly status: string;
  readonly executedTasks: readonly string[];
  readonly findings: readonly { readonly severity: string; readonly code: string; readonly message: string }[];
  readonly usageTotals: object | null;
  readonly contextProviderKind: string;
}

export interface WriteRedactedHandoffResult {
  readonly path: string;
  readonly redacted: boolean;
  readonly truncated: boolean;
}

/**
 * IMPLEMENTATION-PLAN.md §13 flow item 9 / invariant: "raportul final poate fi
 * exportat în `.ai-code-control/handoffs/`, dar numai după redactare și printr-o
 * regulă configurată." The caller is responsible for the "regulă configurată" gate
 * (project config opt-in) - this function only handles the redaction + canonical
 * location part, reusing the same `prepareReportText` free-text pipeline as every
 * other report writer in this file.
 */
export function writeRedactedHandoff(input: WriteRedactedHandoffInput): WriteRedactedHandoffResult {
  const dir = join(input.repositoryPath, ".ai-code-control", "handoffs");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${input.runId}.md`);

  let redacted = false;
  let truncated = false;

  const prepare = (text: string): string => {
    const prepared = prepareReportText(text);
    redacted ||= prepared.redacted;
    truncated ||= prepared.truncated;
    return prepared.text;
  };

  const findingLines =
    input.findings.length === 0
      ? "- No findings."
      : input.findings.map((finding) => `- [${finding.severity}] ${finding.code}: ${prepare(finding.message)}`).join("\n");

  const usageLines =
    input.usageTotals === null
      ? "- No usage data."
      : Object.entries(input.usageTotals as Record<string, unknown>)
          .map(([key, value]) => `- ${key}: ${value === null || value === undefined ? "unknown" : String(value)}`)
          .join("\n");

  writeFileSync(
    path,
    `# ai-code-worker Handoff

- Run ID: ${input.runId}
- Status: ${input.status}
- Context provider: ${input.contextProviderKind}
- Executed tasks: ${input.executedTasks.length === 0 ? "none" : input.executedTasks.join(", ")}

## Findings

${findingLines}

## Usage totals

${usageLines}
`,
    "utf8"
  );

  return { path, redacted, truncated };
}

export interface WriteIndependentReviewReportInput {
  readonly runRoot: string;
  readonly review: IndependentReviewResult;
  readonly registry?: SchemaRegistry;
}

export interface WriteIndependentReviewReportResult {
  readonly path: string;
  readonly redacted: boolean;
  readonly truncated: boolean;
}

/**
 * Persists an independent review (stages 2-3's IndependentReviewResult) with
 * every free-text evidence field redacted and length-capped first. Findings
 * and criterion-coverage evidence come from a review engine's read of the
 * repository and its own output - exactly the "unredacted engine output"
 * the Phase 3 guardrails forbid persisting verbatim. The result stays
 * schema-valid (redaction only ever shortens/replaces substrings within an
 * already-free-text field).
 */
export function writeIndependentReviewReport(input: WriteIndependentReviewReportInput): WriteIndependentReviewReportResult {
  const registry = input.registry ?? SchemaRegistry.load();
  let redacted = false;
  let truncated = false;

  const prepare = (text: string): string => {
    const prepared = prepareReportText(text);
    redacted ||= prepared.redacted;
    truncated ||= prepared.truncated;
    return prepared.text;
  };

  const redactedReview: IndependentReviewResult = {
    ...input.review,
    criterionCoverage: input.review.criterionCoverage.map((entry) => ({ ...entry, evidence: prepare(entry.evidence) })),
    findings: input.review.findings.map((finding) => ({ ...finding, evidence: prepare(finding.evidence) }))
  };

  registry.assertValid("independent-review.schema.json", redactedReview);

  const path = join(input.runRoot, "independent-review.json");
  mkdirSync(input.runRoot, { recursive: true });
  writeFileSync(path, `${JSON.stringify(redactedReview, null, 2)}\n`, "utf8");

  return { path, redacted, truncated };
}
