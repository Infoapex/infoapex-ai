export interface ParsedPlan {
  readonly status: string;
  readonly body: {
    readonly workerContractVersion?: "1.0" | "1.1";
    readonly goal: string;
    readonly tasks: readonly unknown[];
    readonly globalGates: readonly string[];
    readonly budgets: Record<string, unknown>;
  };
}

export class PlanParseError extends Error {
  constructor(
    readonly code: "PLAN_FRONTMATTER_MISSING" | "PLAN_STATUS_MISSING" | "PLAN_BLOCK_MISSING" | "PLAN_BLOCK_INVALID",
    message: string
  ) {
    super(message);
    this.name = "PlanParseError";
  }
}

export function parsePlanMarkdown(markdown: string): ParsedPlan {
  const frontmatter = parseFrontmatter(markdown);
  const status = frontmatter.get("status");

  if (!status) {
    throw new PlanParseError("PLAN_STATUS_MISSING", "Plan frontmatter must include status.");
  }

  const block = extractPlanBlock(markdown);

  try {
    return {
      status,
      body: JSON.parse(block) as ParsedPlan["body"]
    };
  } catch (error) {
    throw new PlanParseError(
      "PLAN_BLOCK_INVALID",
      error instanceof Error ? error.message : "Plan JSON block is invalid."
    );
  }
}

function parseFrontmatter(markdown: string): Map<string, string> {
  const match = /^---\r?\n(?<body>[\s\S]*?)\r?\n---/.exec(markdown);

  if (!match?.groups?.body) {
    throw new PlanParseError("PLAN_FRONTMATTER_MISSING", "Plan must start with YAML-like frontmatter.");
  }

  const values = new Map<string, string>();

  for (const line of match.groups.body.split(/\r?\n/)) {
    const separator = line.indexOf(":");

    if (separator < 0) {
      continue;
    }

    values.set(line.slice(0, separator).trim(), line.slice(separator + 1).trim());
  }

  return values;
}

function extractPlanBlock(markdown: string): string {
  const match = /```(?:json\s+)?ai-code-worker-plan\r?\n(?<json>[\s\S]*?)\r?\n```/.exec(markdown);

  if (!match?.groups?.json) {
    throw new PlanParseError("PLAN_BLOCK_MISSING", "Plan must include an ai-code-worker-plan JSON block.");
  }

  return match.groups.json;
}
