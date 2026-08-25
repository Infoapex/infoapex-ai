import { prepareReportText } from "../runner/redaction.js";
import type { IndependentReviewFinding } from "../review/independent-review.js";
import type { RepairTask } from "./repair-task.js";

export interface BuildRepairPromptInput {
  readonly task: RepairTask;
  readonly findings: readonly IndependentReviewFinding[];
}

export interface BuiltRepairPrompt {
  readonly prompt: string;
  readonly redacted: boolean;
  readonly truncated: boolean;
}

/**
 * The prompt text a real engine would receive for a repair task (Phase 3
 * stage 10 - real Codex/Claude wiring is a separate follow-up, but the
 * prompt shape and its redaction boundary can be built and tested now).
 * Finding evidence is redacted/capped before being embedded, same as any
 * other free-text field persisted or transmitted outside the repository -
 * a finding's evidence can legitimately contain something that looks like
 * a secret (that may be exactly what the finding is about), and it must
 * not be echoed verbatim into a prompt sent to an external engine.
 */
export function buildRepairPrompt(input: BuildRepairPromptInput): BuiltRepairPrompt {
  let redacted = false;
  let truncated = false;

  const relevantFindings = input.findings.filter((finding) => input.task.sourceFindingIds.includes(finding.id));
  const findingsText = relevantFindings
    .map((finding) => {
      const prepared = prepareReportText(finding.evidence);
      redacted ||= prepared.redacted;
      truncated ||= prepared.truncated;
      return `- [${finding.id}] (${finding.severity}/${finding.category}) ${finding.files.join(", ") || "no file listed"}: ${prepared.text}`;
    })
    .join("\n");

  const prompt = `You are repairing a scoped set of findings from an independent code review. Do not modify files outside the allowed paths below, and do not expand scope beyond what each finding describes.

## Allowed paths
${input.task.allowedPaths.map((path) => `- ${path}`).join("\n")}

## Findings to resolve
${findingsText || "- (no findings matched this task's sourceFindingIds)"}

## Verification
After your changes, all of the following must pass:
${input.task.verify.map((command) => `- ${command}`).join("\n")}

Make the minimal change needed to resolve each finding above.`;

  return { prompt, redacted, truncated };
}
