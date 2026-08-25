export interface ReviewPromptTask {
  readonly id: string;
  readonly acceptanceCriteria: readonly string[];
  readonly criterionIds?: readonly string[];
}

export interface BuildReviewPromptInput {
  readonly runId: string;
  readonly reviewId: string;
  readonly graphVersion: number;
  readonly createdAt: string;
  readonly tasks: readonly ReviewPromptTask[];
  /** Diff text per task id, base commit to that task's own commit. A task
   *  missing here (no commit yet - e.g. an unresolved repair task) is listed
   *  as "no diff available" rather than silently omitted. */
  readonly diffsByTask: Readonly<Record<string, string>>;
  readonly context?: string;
}

/**
 * IMPLEMENTATION-PLAN.md §9.3: an independent review runs read-only, in a fresh
 * context, without the implementer's own conversational history - it sees only the
 * diff and the acceptance criteria, the same evidence a human reviewer would get from
 * a pull request. The model is instructed to respond with ONLY the JSON object
 * (no prose), matching independent-review.schema.json exactly - client-side schema
 * validation is the fail-closed enforcement, the same pattern already used for
 * agent-result.schema.json in claude-cli.ts/codex-cli.ts.
 */
export function buildReviewPrompt(input: BuildReviewPromptInput): string {
  const taskSections = input.tasks
    .map((task) => {
      const diff = input.diffsByTask[task.id];
      const criteria = task.acceptanceCriteria.length > 0
        ? task.acceptanceCriteria.map((criterion, index) => `  - ${task.criterionIds?.[index] ?? criterion}: ${criterion}`).join("\n")
        : "  - (none declared)";

      return `### Task ${task.id}

Acceptance criteria:
${criteria}

Diff:
\`\`\`diff
${diff && diff.length > 0 ? diff : "(no diff available for this task)"}
\`\`\``;
    })
    .join("\n\n");

  return `You are an independent, read-only code reviewer. You have not seen the
implementation conversation and must judge only the evidence below: each task's
acceptance criteria and its diff. Do not assume anything the diff does not show. Do
not edit any files - you have no write access, and any recommendation belongs in a
finding, not an action.

${taskSections}

${input.context && input.context.length > 0 ? `## Advisory repository context\n\n${input.context}\n` : ""}

## Your response

Respond with ONLY a single JSON object (no prose, no markdown fences) matching this
exact shape:

{
  "schemaVersion": "1.0",
  "runId": "${input.runId}",
  "reviewId": "${input.reviewId}",
  "reviewer": "<your engine name>",
  "graphVersion": ${input.graphVersion},
  "createdAt": "${input.createdAt}",
  "verdict": "pass" | "fail",
  "criterionCoverage": [
    { "criterionId": "<criterion id>", "verdict": "supported" | "weak" | "missing" | "contradicted", "tests": ["..."], "commands": ["..."], "evidence": "<why>" }
  ],
  "findings": [
    { "id": "<stable id, e.g. REV-001>", "severity": "blocking" | "major" | "minor" | "note", "category": "<short category>", "criterionIds": ["..."], "files": ["..."], "evidence": "<what's wrong and why>" }
  ]
}

Include one criterionCoverage entry per acceptance criterion listed above, across all
tasks. "verdict" is "fail" if and only if at least one finding has severity
"blocking". An empty diff for a task is itself evidence - do not mark criteria
"supported" without something in the diff to support them.`;
}
