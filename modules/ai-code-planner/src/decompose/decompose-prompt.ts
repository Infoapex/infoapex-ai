import type { PlannerAdapter } from '../engine/planner-adapter.js';
import type { ProviderSelection } from '../engine/provider-registry.js';
import { validateAgainstSchema } from '../schema-validate.js';
import { applyRoutingProposal } from '../routing/propose-routing.js';
import { contextForPrompt, type PlannerContext } from '../context/types.js';
import type { Plan } from '../types.js';

export interface DecomposeOptions {
  readonly context?: PlannerContext;
  readonly selection: ProviderSelection;
}

export function decomposePrompt(
  adapter: PlannerAdapter,
  prompt: string,
  options: DecomposeOptions
): { ok: true; plan: Plan } | { ok: false; error: string } {
  const startedAt = Date.now();
  const firstAsk = adapter.ask(buildInitialPrompt(prompt, options.context));
  if (!firstAsk.ok) {
    return { ok: false, error: firstAsk.error };
  }

  const firstExtract = extractAndValidatePlan(firstAsk.text);
  if (firstExtract.ok) {
    return { ok: true, plan: finalizePlan(firstExtract.plan, firstAsk, options.selection, startedAt) };
  }

  const retryAsk = adapter.ask(
    buildRetryPrompt(prompt, firstExtract.rawJson, firstExtract.errors, options.context)
  );
  if (!retryAsk.ok) {
    return { ok: false, error: retryAsk.error };
  }

  const retryExtract = extractAndValidatePlan(retryAsk.text);
  if (retryExtract.ok) {
    return { ok: true, plan: finalizePlan(retryExtract.plan, retryAsk, options.selection, startedAt) };
  }

  return {
    ok: false,
    error: `Plan validation failed after retry: ${retryExtract.errors.join('; ')}`
  };
}

function buildInitialPrompt(userPrompt: string, context: PlannerContext | undefined): string {
  return `Decompose the following task into a JSON implementation plan.

Task: ${userPrompt}

${contextForPrompt(context)}

Produce a JSON object with exactly this shape:
{
  "goal": "<high-level goal string>",
  "tasks": [
    {
      "id": "<unique task identifier matching ^[A-Z0-9][A-Z0-9._-]*$>",
      "goal": "<what this task must accomplish>",
      "acceptanceCriteria": [
        { "criterionId": "<stable id>", "text": "<human-readable criterion>" }
      ],
      "gates": [
        { "gateId": "<stable id>", "command": "<command to run>", "evidenceContract": "<what constitutes passing>", "criterionIds": ["<criterion id verified by this gate>"] }
      ],
      "dependsOn": [],
      "scope": {
        "allowedPaths": ["<paths this task may read or write>"],
        "forbiddenPaths": ["<paths this task must not touch>"]
      },
      "requiredInputs": [
        { "kind": "file", "ref": "<file path>" }
      ],
      "risk": "low | medium | high",
      "relevantSymbols": ["<optional symbol>"]
    }
  ]
}

Required fields:
- goal: non-empty string
- tasks: array of task objects, each requiring:
  - id: non-empty string (unique within this plan)
  - goal: non-empty string describing what this task accomplishes
  - acceptanceCriteria: array of objects with criterionId (string) and text (string)
  - gates: array of objects with gateId, command, evidenceContract, and non-empty criterionIds; every criterion must be covered and references must resolve within the task
  - id and every dependsOn entry must match ^[A-Z0-9][A-Z0-9._-]*$ (uppercase worker-compatible identifiers)
  - dependsOn: array of task id strings (empty array if no dependencies)
  - scope: object with allowedPaths (string array) and forbiddenPaths (string array)
- requiredInputs: array of objects with kind ("file" | "symbol" | "external") and ref (string)
- risk is required for every task: classify migrations, persistence, security, ML boundaries, and P5 readiness conservatively; relevantSymbols is optional

Respond with ONLY the JSON object. It must be the final thing in your response.`;
}

function buildRetryPrompt(
  userPrompt: string,
  invalidJson: string | undefined,
  errors: string[],
  context: PlannerContext | undefined
): string {
  const invalidSection = invalidJson != null
    ? `\nThe JSON extracted from your previous response was:\n${invalidJson}\n`
    : '\nNo valid JSON object was found in your previous response.\n';

  return `Your previous response did not produce a valid plan. Please fix it and try again.

Original task: ${userPrompt}
\n${contextForPrompt(context)}
${invalidSection}
Validation errors from your previous response:
${errors.map(e => `- ${e}`).join('\n')}

Produce a corrected JSON object with exactly this shape:
{
  "goal": "<high-level goal string>",
  "tasks": [
    {
      "id": "<unique task identifier matching ^[A-Z0-9][A-Z0-9._-]*$>",
      "goal": "<what this task must accomplish>",
      "acceptanceCriteria": [
        { "criterionId": "<stable id>", "text": "<human-readable criterion>" }
      ],
      "gates": [
        { "gateId": "<stable id>", "command": "<command to run>", "evidenceContract": "<what constitutes passing>", "criterionIds": ["<criterion id verified by this gate>"] }
      ],
      "dependsOn": [],
      "scope": {
        "allowedPaths": ["<paths this task may read or write>"],
        "forbiddenPaths": ["<paths this task must not touch>"]
      },
      "requiredInputs": [
        { "kind": "file", "ref": "<file path>" }
      ],
      "risk": "low | medium | high",
      "relevantSymbols": ["<optional symbol>"]
    }
  ]
}

Required fields:
- goal: non-empty string
- tasks: array of task objects, each requiring:
  - id: non-empty string (unique within this plan)
  - goal: non-empty string describing what this task accomplishes
  - acceptanceCriteria: array of objects with criterionId (string) and text (string)
  - gates: array of objects with gateId, command, evidenceContract, and non-empty criterionIds; every criterion must be covered and references must resolve within the task
  - id and every dependsOn entry must match ^[A-Z0-9][A-Z0-9._-]*$ (uppercase worker-compatible identifiers)
  - dependsOn: array of task id strings (empty array if no dependencies)
  - scope: object with allowedPaths (string array) and forbiddenPaths (string array)
- requiredInputs: array of objects with kind ("file" | "symbol" | "external") and ref (string)
- risk is required for every task: classify migrations, persistence, security, ML boundaries, and P5 readiness conservatively; relevantSymbols is optional

Respond with ONLY the JSON object. It must be the final thing in your response.`;
}

function finalizePlan(plan: Plan, result: Extract<ReturnType<PlannerAdapter['ask']>, { ok: true }>, selection: ProviderSelection, startedAt: number): Plan {
  const routed = applyRoutingProposal(plan);
  return {
    ...routed,
    planningProvenance: {
      ...(routed.planningProvenance ?? {}),
      schemaVersion: 'planner-provenance-v2',
      mode: 'single-agent',
      panelMembers: [{
        id: 'planner',
        role: 'proposer',
        providerId: result.providerId,
        requestedModel: selection.model,
        resolvedModel: result.resolvedModel,
        reasoningEffort: selection.reasoningEffort,
        selectionReason: selection.selectionReason,
        fallback: selection.fallback,
        policyVersion: 'planner-provider-registry-v1'
      }],
      roundsUsed: 1,
      roundsAllowed: 1,
      outcome: 'CONSENSUS',
      findings: { total: 0, verified: 0, refuted: 0, acceptedAsAssumption: 0, needsHuman: 0 },
      estimatedPlanningCostUsd: selection.estimatedCostUsd,
      actualPlanningCostUsd: null,
      planningCostSource: 'operator-declared-cap; provider usage is recorded separately and must not be converted into a billed cost without provider billing evidence',
      planningUsage: result.usage,
      planningDurationSec: Math.max(0, Math.ceil((Date.now() - startedAt) / 1000))
    }
  };
}

type ExtractResult =
  | { ok: true; plan: Plan }
  | { ok: false; rawJson: string | undefined; errors: string[] };

function extractAndValidatePlan(text: string): ExtractResult {
  const candidates = candidatePlanObjects(text);

  if (candidates.length === 0) {
    return { ok: false, rawJson: undefined, errors: ['No JSON object found in response'] };
  }

  let firstRawJson: string | undefined;
  let firstErrors: string[] = [];

  for (let i = 0; i < candidates.length; i++) {
    const candidate = candidates[i];
    const rawJson = JSON.stringify(candidate);
    const result = validateAgainstSchema<Plan>('plan.schema.json', candidate);
    if (result.valid) {
      return { ok: true, plan: result.data };
    }
    if (i === 0) {
      firstRawJson = rawJson;
      firstErrors = result.errors;
    }
  }

  return { ok: false, rawJson: firstRawJson, errors: firstErrors };
}

// Replicates ai-code-worker's candidateAgentResultObjects/topLevelBraceSpans strategy:
// scan every top-level balanced {...} span (ignoring braces inside string literals),
// try them last-to-first so the real object (instructed to be final) is tried first.
// --json-schema is documented but non-functional per the same constraint in
// src/engines/claude-cli.ts, so structured output is enforced by prompt instruction
// plus client-side schema validation here.
function candidatePlanObjects(text: string): readonly unknown[] {
  const direct = tryParseJson(text);
  if (direct !== undefined) {
    return [direct];
  }

  const spans = topLevelBraceSpans(text);
  const candidates: unknown[] = [];

  for (let i = spans.length - 1; i >= 0; i--) {
    const span = spans[i]!;
    const parsed = tryParseJson(text.slice(span.start, span.end));
    if (parsed !== undefined) {
      candidates.push(parsed);
    }
  }

  return candidates;
}

function tryParseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function topLevelBraceSpans(text: string): readonly { start: number; end: number }[] {
  const spans: { start: number; end: number }[] = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;

  for (let i = 0; i < text.length; i++) {
    const char = text[i]!;

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
    } else if (char === '{') {
      if (depth === 0) {
        start = i;
      }
      depth++;
    } else if (char === '}') {
      if (depth > 0) {
        depth--;
        if (depth === 0 && start !== -1) {
          spans.push({ start, end: i + 1 });
          start = -1;
        }
      }
    }
  }

  return spans;
}
