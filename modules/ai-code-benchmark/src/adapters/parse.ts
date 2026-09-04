import type { AdapterUsage } from "../types.js";
import { CLAUDE_USAGE_PARSER_VERSION, CODEX_USAGE_PARSER_VERSION, INFOAPEX_USAGE_PARSER_VERSION, parseClaudeUsage, parseCodexUsage, parseInfoapexUsage } from "../metrics.js";

export const CODEX_PARSER_VERSION = CODEX_USAGE_PARSER_VERSION;
export const CLAUDE_PARSER_VERSION = CLAUDE_USAGE_PARSER_VERSION;
export const INFOAPEX_PARSER_VERSION = INFOAPEX_USAGE_PARSER_VERSION;

export function unknownUsage(): AdapterUsage { return { inputUncachedTokens: null, cacheReadTokens: null, cacheWriteTokens: null, outputTokens: null, totalTokens: null, costUsd: null }; }

export function parseClaudeOutput(output: string): { readonly valid: boolean; readonly usage: AdapterUsage; readonly model: string | null } {
  const value = parseClaudeUsage(output);
  return { valid: value.valid, usage: value.usage, model: value.model };
}

export function parseCodexOutput(output: string): { readonly valid: boolean; readonly usage: AdapterUsage; readonly model: string | null } {
  const value = parseCodexUsage(output);
  return { valid: value.valid, usage: value.usage, model: value.model };
}

export function parseInfoapexOutput(output: string): { readonly valid: boolean; readonly usage: AdapterUsage; readonly model: string | null } {
  const value = parseInfoapexUsage(output);
  return { valid: value.valid, usage: value.usage, model: value.model };
}
