import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const AGENTS_MD_BLOCK_VERSION = "1";

const BLOCK_START_PATTERN = /<!-- ai-code-worker:block v(\d+) -->/;
const BLOCK_END_MARKER = "<!-- /ai-code-worker:block -->";
const CURRENT_BLOCK_START = `<!-- ai-code-worker:block v${AGENTS_MD_BLOCK_VERSION} -->`;

/**
 * IMPLEMENTATION-PLAN.md §5.2: "Installerul propune, dar nu adaugă fără
 * confirmare, un bloc delimitat și versionat" - this is that block, delimited by
 * an HTML-comment marker pair so a future `update`/`init` can find and replace exactly
 * this block without touching anything else the repository owner wrote in
 * AGENTS.md.
 */
export function buildAgentsMdBlock(): string {
  return `${CURRENT_BLOCK_START}
## ai-code-worker

Folosește ai-code-worker numai când utilizatorul îl invocă explicit sau cere ca un
plan să fie executat prin el. Nu începe implementarea înainte ca manifestul rulării
să fie valid și înghețat și authorization binding-ul să fie valid. Configurația
worker-ului este în \`.ai-code-worker/\`; starea operațională este în state root-ul
extern. Respectă rezultatul DONE/BLOCKED al worker-ului.
${BLOCK_END_MARKER}
`;
}

export type AgentsMdBlockState = "MISSING" | "CURRENT" | "STALE";

export interface ProposedAgentsMdBlock {
  readonly content: string;
  readonly state: AgentsMdBlockState;
  /** True only when `state === "CURRENT"` - kept for callers that only care
   *  "is there anything to do", alongside the finer-grained `state`. */
  readonly alreadyPresent: boolean;
  readonly existingVersion: string | null;
  readonly path: string;
}

interface ExistingBlockSpan {
  readonly version: string;
  readonly start: number;
  /** Exclusive; the index right after BLOCK_END_MARKER. */
  readonly end: number;
}

function findExistingBlock(content: string): ExistingBlockSpan | null {
  const startMatch = BLOCK_START_PATTERN.exec(content);

  if (!startMatch) {
    return null;
  }

  const endIndex = content.indexOf(BLOCK_END_MARKER, startMatch.index);

  // A start marker with no matching end marker is malformed (hand-edited?) -
  // treat as "no block found" rather than guessing where it ends, so nothing gets
  // silently mangled.
  if (endIndex === -1) {
    return null;
  }

  return { version: startMatch[1]!, start: startMatch.index, end: endIndex + BLOCK_END_MARKER.length };
}

export function proposeAgentsMdBlock(repositoryRoot: string): ProposedAgentsMdBlock {
  const path = join(repositoryRoot, "AGENTS.md");
  const content = buildAgentsMdBlock();
  const existing = existsSync(path) ? readFileSync(path, "utf8") : "";
  const existingBlock = findExistingBlock(existing);
  const state: AgentsMdBlockState = !existingBlock ? "MISSING" : existingBlock.version === AGENTS_MD_BLOCK_VERSION ? "CURRENT" : "STALE";

  return {
    content,
    state,
    alreadyPresent: state === "CURRENT",
    existingVersion: existingBlock?.version ?? null,
    path
  };
}

export interface WriteAgentsMdBlockResult {
  readonly status: "APPENDED" | "ALREADY_PRESENT" | "REPLACED";
  readonly path: string;
  readonly previousVersion?: string;
}

/**
 * The confirmation step for the proposal above - only called when the caller
 * (an explicit `--write-agents-md` CLI flag, never `init`'s default path) has
 * opted in.
 *
 * Three outcomes: no block yet -> append after existing content (never truncates a
 * file that may hold unrelated project instructions); current version already
 * present -> no-op; an OLDER version's block is present -> replace exactly that
 * block's span in place, leaving everything else in the file untouched. Detecting
 * "older" only requires the version marker to differ from AGENTS_MD_BLOCK_VERSION -
 * there is deliberately no attempt to diff or preserve any hand-edits a repository
 * owner made *inside* a stale block, since the block's whole point is to be
 * worker-managed content, not a place for local customization.
 */
export function writeAgentsMdBlock(repositoryRoot: string): WriteAgentsMdBlockResult {
  const proposal = proposeAgentsMdBlock(repositoryRoot);

  if (proposal.state === "CURRENT") {
    return { status: "ALREADY_PRESENT", path: proposal.path };
  }

  const existing = existsSync(proposal.path) ? readFileSync(proposal.path, "utf8") : "";

  if (proposal.state === "STALE") {
    const existingBlock = findExistingBlock(existing)!;
    const replaced = existing.slice(0, existingBlock.start) + proposal.content.trimEnd() + existing.slice(existingBlock.end);
    writeFileSync(proposal.path, replaced, "utf8");
    return { status: "REPLACED", path: proposal.path, previousVersion: existingBlock.version };
  }

  const separator = existing.length > 0 && !existing.endsWith("\n\n") ? (existing.endsWith("\n") ? "\n" : "\n\n") : "";
  writeFileSync(proposal.path, `${existing}${separator}${proposal.content}`, "utf8");

  return { status: "APPENDED", path: proposal.path };
}
