import { readFileSync } from "node:fs";
import { SchemaRegistry } from "../schema/json-schema.js";
import type { IndependentReviewResult } from "./independent-review.js";

/**
 * Loads a fake/local independent-review fixture from disk and validates it
 * against independent-review.schema.json. Used by Phase 3 stage 2 so that
 * review-finding ingestion can be proven deterministically before any real
 * Codex/Claude reviewer is wired in (HANDOFF-PHASE-3-CLAUDE.md, step 2).
 */
export function loadReviewFixture(path: string, registry?: SchemaRegistry): IndependentReviewResult {
  const parsed = JSON.parse(readFileSync(path, "utf8")) as IndependentReviewResult;

  (registry ?? SchemaRegistry.load()).assertValid("independent-review.schema.json", parsed);

  return parsed;
}
