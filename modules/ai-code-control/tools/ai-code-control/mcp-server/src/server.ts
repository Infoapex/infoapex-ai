import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { execa } from "execa";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// REPO_ROOT is the target repository whose memory/code graph is managed.
// ACC_TOOL_ROOT is the ai-code-control checkout; it may be a submodule.
const REPO_ROOT = process.env.REPO_ROOT ?? path.resolve(__dirname, "../../../..");
const TOOL_ROOT = process.env.ACC_TOOL_ROOT
  ? path.resolve(REPO_ROOT, process.env.ACC_TOOL_ROOT)
  : REPO_ROOT;

const PUBLISH_DIR = path.join(TOOL_ROOT, "tools/ai-code-control/bin/publish");
const BIN_NATIVE = path.join(
  PUBLISH_DIR,
  process.platform === "win32" ? "AiCodeControl.Cli.exe" : "AiCodeControl.Cli"
);
const BIN_DLL = path.join(PUBLISH_DIR, "AiCodeControl.Cli.dll");
const CLI_PROJECT = path.join(
  TOOL_ROOT,
  "tools/ai-code-control/src/AiCodeControl.Cli/AiCodeControl.Cli.csproj"
);

// Prefer the native executable; fall back to framework-dependent publish
// ("dotnet <dll>") which is what a cross-platform publish produces.
function cliInvocation(args: string[]): { file: string; args: string[] } {
  if (fs.existsSync(BIN_NATIVE)) return { file: BIN_NATIVE, args };
  if (fs.existsSync(BIN_DLL)) return { file: "dotnet", args: [BIN_DLL, ...args] };
  if (fs.existsSync(CLI_PROJECT))
    return { file: "dotnet", args: ["run", "--project", CLI_PROJECT, "--", ...args] };
  throw new Error(`AI Code Control CLI not found under ${TOOL_ROOT}`);
}

// run_validation can legitimately take minutes; everything else is fast.
const CLI_TIMEOUT_MS = Number(process.env.ACC_TOOL_TIMEOUT_MS ?? 300_000);

interface CliResult {
  text: string;
  isError: boolean;
}

async function runCli(args: string[]): Promise<CliResult> {
  try {
    const invocation = cliInvocation(args);
    const result = await execa(invocation.file, invocation.args, {
      cwd: REPO_ROOT,
      timeout: CLI_TIMEOUT_MS,
    });
    return { text: result.stdout, isError: false };
  } catch (err: unknown) {
    const e = err as {
      stdout?: string;
      stderr?: string;
      message?: string;
      timedOut?: boolean;
      exitCode?: number;
    };
    const out = [e.stdout, e.stderr].filter(Boolean).join("\n").trim();
    const text = e.timedOut
      ? `CLI timed out after ${CLI_TIMEOUT_MS}ms.\n${out}`.trim()
      : out || (e.message ?? "CLI error");
    // Exit code 2 = check failed (verify/guard/validation): a valid result for
    // the model to read, not a protocol error.
    const isError = e.exitCode !== 2;
    return { text, isError };
  }
}

const TOOLS: Tool[] = [
  {
    name: "index_code",
    description:
      "Incrementally index C#, TypeScript/JavaScript and SQL sources. Use full=true only for a clean rebuild.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Path relative to repository root (default: .)" },
        full: { type: "boolean", description: "Delete and rebuild supported-language entries" },
      },
    },
  },
  {
    name: "obsidian_export",
    description:
      "Atomically export code and typed trace graphs as disposable Obsidian Markdown/Canvas projections. Canonical sources and SQLite remain authoritative.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Scope relative to repository root (default: .)" },
        out: { type: "string", description: "Output vault path (default: docs/code-map/generated)" },
        includeSymbols: { type: "boolean", description: "Generate selected symbol notes" },
        maxSymbols: { type: "number", description: "Maximum symbol notes (default: 250)" },
        includeAdvisory: { type: "boolean", description: "Include T2 advisory trace nodes and edges (default: false)" },
        includeSuperseded: { type: "boolean", description: "Include superseded trace entities (default: false)" },
      },
    },
  },
  {
    name: "trace_ingest",
    description:
      "Build or atomically replace the deterministic T0/T1 trace cache from an explicit repository-local manifest. No discovery or LLM inference is performed.",
    inputSchema: {
      type: "object",
      properties: {
        manifest: { type: "string", description: "Declared trace ingest manifest inside the repository" },
        expectedCommit: { type: "string", description: "Source commit override; defaults to Git HEAD" },
        noCodeIndex: { type: "boolean", description: "Do not include current file/symbol nodes" },
        dryRun: { type: "boolean", description: "Parse and resolve without changing the trace cache" },
      },
      required: ["manifest"],
    },
  },
  {
    name: "find_symbol",
    description: "Find a symbol (function, class, method) in the codebase by name.",
    inputSchema: {
      type: "object",
      properties: {
        symbol: { type: "string", description: "Symbol name to search for" },
      },
      required: ["symbol"],
    },
  },
  {
    name: "refresh_context",
    description:
      "Refresh both persistent memory and the incremental code graph for the current branch.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Path relative to repository root (default: .)" },
        full: { type: "boolean", description: "Perform a full code graph rebuild" },
      },
    },
  },
  {
    name: "impact_analysis",
    description:
      "Analyse the blast radius of modifying a symbol. Returns callers, affected files and risk level.",
    inputSchema: {
      type: "object",
      properties: {
        symbol: { type: "string", description: "Fully-qualified symbol name" },
        depth: { type: "number", description: "Maximum caller traversal depth (default: 5)" },
      },
      required: ["symbol"],
    },
  },
  {
    name: "trace_entity",
    description:
      "Traverse declared T0/T1 trace relationships for an exact entity. This is the trace-graph route; it never falls back to memory search or the structural code graph.",
    inputSchema: traceInputSchema("Any exact trace node id, canonical reference, title, or unambiguous simple name"),
  },
  {
    name: "why_trace",
    description:
      "Explain why a symbol or file is connected to decisions, contracts, tasks, and evidence through bounded trace traversal. Use find_symbol for lookup-only questions.",
    inputSchema: traceInputSchema("Exact symbol or repository-relative file trace identity"),
  },
  {
    name: "affected_trace",
    description:
      "Traverse declared downstream and neighboring trace relationships for a contract or ADR. Use impact_analysis for structural symbol blast radius.",
    inputSchema: traceInputSchema("Exact contract or ADR trace identity"),
  },
  {
    name: "current_trace",
    description:
      "Resolve the current ADR or rule by following declared supersedes edges. Branching lineages return ambiguous.",
    inputSchema: traceInputSchema("Exact ADR or rule trace identity"),
  },
  {
    name: "evidence_for",
    description:
      "Follow declared verified_by edges from a criterion or task to gates and runtime evidence.",
    inputSchema: traceInputSchema("Exact criterion or task trace identity"),
  },
  {
    name: "graph_drift",
    description:
      "Check authoritative trace graph integrity, source/commit freshness, supersession consistency, criterion evidence coverage, expected fixtures, and optional projection drift.",
    inputSchema: {
      type: "object",
      properties: {
        scope: { type: "string", description: "Repository-root enforcement scope; v1 accepts . only" },
        sources: { type: "string", description: "Declared canonical source manifest inside scope" },
        expectedGraph: { type: "string", description: "Expected trace graph fixture inside scope" },
        projectionManifest: { type: "string", description: "GRAPH-04 projection manifest inside scope" },
        minimumCoverage: { type: "number", minimum: 0, maximum: 100, description: "Required criterion evidence coverage percent (default: 100)" },
        expectedCommit: { type: "string", description: "Optional source commit precondition; repository HEAD is used by default" },
        skipFreshness: { type: "boolean", description: "Disable repository HEAD freshness comparison" },
        failOnReview: { type: "boolean", description: "Treat REVIEW_REQUIRED as a check-failed exit status" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "run_validation",
    description:
      "Run the project's configured validation toolchains (build, lint, typecheck, tests - as defined in code-control.json) and return per-command results.",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "health_check",
    description:
      "Report tool health: databases present, files/symbols indexed, configured toolchains.",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "refactor_guard",
    description:
      "Full guard: verify changed files against the active plan, then run all validation toolchains.",
    inputSchema: {
      type: "object",
      properties: {
        plan: {
          type: "string",
          description:
            "Relative path to current-plan.json (default: .ai-code-control/reports/refactor/current-plan.json)",
        },
      },
    },
  },
  {
    name: "index_python",
    description:
      "Rebuild the code graph for Python sources under a path. Run after editing Python code so find_symbol/impact_analysis stay fresh.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Path to index, relative to repo root (default: .)" },
      },
    },
  },
  {
    name: "index_rust",
    description:
      "Rebuild the code graph for Rust sources under a path. Run after editing Rust code so find_symbol/impact_analysis stay fresh.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Path to index, relative to repo root (default: .)" },
      },
    },
  },
  {
    name: "memory_init",
    description:
      "Initialize the memory database and markdown skeleton (idempotent).",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "memory_prune",
    description:
      "Remove index entries whose source markdown files were deleted or are no longer included.",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "verify_changed_files",
    description:
      "Check that git-changed files comply with the active current-plan.json. Returns violations if any.",
    inputSchema: {
      type: "object",
      properties: {
        plan: {
          type: "string",
          description:
            "Relative path to current-plan.json (default: .ai-code-control/reports/refactor/current-plan.json)",
        },
      },
    },
  },
  {
    name: "memory_search",
    description: "Search persistent memory (ADRs, task summaries, project notes) by keyword.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search query" },
        limit: {
          type: "number",
          description: "Max results to return (default: 5)",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "memory_brief",
    description:
      "Generate a context brief for a task from persistent memory. Returns relevant decisions and past summaries.",
    inputSchema: {
      type: "object",
      properties: {
        task: {
          type: "string",
          description: "Short description of the task you are about to perform",
        },
      },
      required: ["task"],
    },
  },
  {
    name: "memory_health",
    description: "Check freshness and size of persistent memory against canonical files.",
    inputSchema: {
      type: "object",
      properties: {
        failOnStale: { type: "boolean", description: "Return check-failed exit status when stale" },
      },
    },
  },
  {
    name: "memory_ingest",
    description:
      "Rebuild the memory search index from markdown sources (run after adding or editing memory files).",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "memory_add_task_summary",
    description:
      "Record a summary of the completed task into persistent memory using the current git diff.",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", description: "Short title for the task summary" },
      },
      required: ["title"],
    },
  },
];

async function dispatch(name: string, args: Record<string, unknown>): Promise<CliResult> {
  switch (name) {
    case "find_symbol":
      return runCli(["find-symbol", String(args.symbol)]);

    case "impact_analysis":
      return runCli([
        "impact-analysis",
        String(args.symbol),
        "--depth",
        String(args.depth ?? 5),
      ]);

    case "trace_entity":
      return runCli(traceCliArgs("trace", args));

    case "why_trace":
      return runCli(traceCliArgs("why", args));

    case "affected_trace":
      return runCli(traceCliArgs("affected", args));

    case "current_trace":
      return runCli(traceCliArgs("current", args));

    case "evidence_for":
      return runCli(traceCliArgs("evidence-for", args));

    case "graph_drift": {
      const cliArgs = ["graph-drift", "--scope", String(args.scope ?? "."), "--format", "json"];
      if (args.sources !== undefined) cliArgs.push("--sources", String(args.sources));
      if (args.expectedGraph !== undefined) cliArgs.push("--expected-graph", String(args.expectedGraph));
      if (args.projectionManifest !== undefined) cliArgs.push("--projection-manifest", String(args.projectionManifest));
      if (args.minimumCoverage !== undefined) cliArgs.push("--minimum-coverage", String(args.minimumCoverage));
      if (args.expectedCommit !== undefined) cliArgs.push("--expected-commit", String(args.expectedCommit));
      if (args.skipFreshness === true) cliArgs.push("--skip-freshness");
      if (args.failOnReview === true) cliArgs.push("--fail-on-review");
      return runCli(cliArgs);
    }

    case "run_validation":
      return runCli(["run-validation"]);

    case "health_check":
      return runCli(["health-check"]);

    case "refactor_guard": {
      const cliArgs = ["refactor-guard"];
      if (args.plan) cliArgs.push("--plan", String(args.plan));
      return runCli(cliArgs);
    }

    case "index_python":
      return runCli(["index-python", "--path", String(args.path ?? ".")]);

    case "index_rust":
      return runCli(["index-rust", "--path", String(args.path ?? ".")]);

    case "index_code": {
      const cliArgs = ["index-code", "--path", String(args.path ?? ".")];
      if (args.full === true) cliArgs.push("--full");
      return runCli(cliArgs);
    }

    case "obsidian_export": {
      const cliArgs = ["obsidian-export", "--path", String(args.path ?? ".")];
      if (args.out) cliArgs.push("--out", String(args.out));
      if (args.includeSymbols === true) cliArgs.push("--include-symbols");
      if (args.maxSymbols) cliArgs.push("--max-symbols", String(args.maxSymbols));
      if (args.includeAdvisory === true) cliArgs.push("--include-advisory");
      if (args.includeSuperseded === true) cliArgs.push("--include-superseded");
      return runCli(cliArgs);
    }

    case "trace_ingest": {
      const cliArgs = ["trace-ingest", "--manifest", String(args.manifest)];
      if (args.expectedCommit) cliArgs.push("--expected-commit", String(args.expectedCommit));
      if (args.noCodeIndex === true) cliArgs.push("--no-code-index");
      if (args.dryRun === true) cliArgs.push("--dry-run");
      return runCli(cliArgs);
    }

    case "refresh_context": {
      const cliArgs = ["refresh", "--path", String(args.path ?? ".")];
      if (args.full === true) cliArgs.push("--full");
      return runCli(cliArgs);
    }

    case "memory_init":
      return runCli(["memory-init"]);

    case "memory_prune":
      return runCli(["memory-prune"]);

    case "verify_changed_files": {
      const cliArgs = ["verify-changed-files"];
      if (args.plan) cliArgs.push("--plan", String(args.plan));
      return runCli(cliArgs);
    }

    case "memory_search": {
      const cliArgs = ["memory-search", String(args.query)];
      if (args.limit) cliArgs.push("--limit", String(args.limit));
      return runCli(cliArgs);
    }

    case "memory_brief":
      return runCli(["memory-brief", String(args.task)]);

    case "memory_health":
      return runCli([
        "memory-health",
        ...(args.failOnStale === true ? ["--fail-on-stale"] : []),
      ]);

    case "memory_ingest":
      return runCli(["memory-ingest"]);

    case "memory_add_task_summary":
      return runCli([
        "memory-add-task-summary",
        "--title",
        String(args.title),
        "--from-current-git-diff",
      ]);

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

function traceInputSchema(entityDescription: string): Tool["inputSchema"] {
  return {
    type: "object",
    properties: {
      entity: { type: "string", description: entityDescription },
      depth: { type: "integer", minimum: 1, maximum: 10, description: "Traversal depth (default: 3)" },
      maxNodes: { type: "integer", minimum: 1, maximum: 200, description: "Hard node budget (default: 50)" },
      maxEdges: { type: "integer", minimum: 1, maximum: 500, description: "Hard edge budget (default: 100)" },
      includeAdvisory: { type: "boolean", description: "Opt in to T2 inferred data; returned results are marked advisory" },
      expectedCommit: { type: "string", description: "Optional source commit freshness precondition; CLI uses repository HEAD by default" },
      skipFreshness: { type: "boolean", description: "Do not compare trace ingest commits with repository HEAD" },
    },
    required: ["entity"],
    additionalProperties: false,
  };
}

function traceCliArgs(command: string, args: Record<string, unknown>): string[] {
  const cliArgs = [command, String(args.entity)];
  if (args.depth !== undefined) cliArgs.push("--depth", String(args.depth));
  if (args.maxNodes !== undefined) cliArgs.push("--max-nodes", String(args.maxNodes));
  if (args.maxEdges !== undefined) cliArgs.push("--max-edges", String(args.maxEdges));
  if (args.includeAdvisory === true) cliArgs.push("--include-advisory");
  if (args.expectedCommit !== undefined) cliArgs.push("--expected-commit", String(args.expectedCommit));
  if (args.skipFreshness === true) cliArgs.push("--skip-freshness");
  return cliArgs;
}

const server = new Server(
  { name: "ai-code-control", version: "1.2.0" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args = {} } = req.params;
  const result = await dispatch(name, args as Record<string, unknown>);
  return {
    content: [{ type: "text", text: result.text }],
    isError: result.isError,
  };
});

const transport = new StdioServerTransport();
await server.connect(transport);
