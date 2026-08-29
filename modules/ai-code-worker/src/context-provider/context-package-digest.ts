import { createHash } from "node:crypto";
import type { ContextPackage } from "./types.js";

export function computeContextPackageDigest(contextPackage: ContextPackage): string {
  const semantic = {
    schemaVersion: contextPackage.schemaVersion,
    runId: contextPackage.runId,
    taskId: contextPackage.taskId,
    manifestSha256: contextPackage.manifestSha256,
    compilerVersion: contextPackage.compilerVersion,
    sources: [...contextPackage.sources]
      .sort((left, right) =>
        compare(left.sourceId, right.sourceId) ||
        compare(left.canonicalRef, right.canonicalRef) ||
        compare(left.sourceHash, right.sourceHash)
      )
      .map((source) => ({
        sourceId: source.sourceId,
        sourceType: source.sourceType,
        canonicalRef: source.canonicalRef,
        sourceHash: source.sourceHash,
        sourceCommit: source.sourceCommit,
        authority: source.authority,
        selectionReason: source.selectionReason,
        ...(source.contentRange ? { contentRange: source.contentRange } : {}),
        ...(source.renderedContent !== undefined ? { renderedContent: source.renderedContent } : {})
      })),
    budget: {
      measurement: contextPackage.budget.measurement,
      maximumTokens: contextPackage.budget.maximumTokens,
      estimatedTokens: contextPackage.budget.estimatedTokens,
      ...(contextPackage.budget.maximumCharacters !== undefined
        ? { maximumCharacters: contextPackage.budget.maximumCharacters }
        : {}),
      ...(contextPackage.budget.estimatedCharacters !== undefined
        ? { estimatedCharacters: contextPackage.budget.estimatedCharacters }
        : {}),
      omittedSources: [...contextPackage.budget.omittedSources]
        .sort((left, right) => compare(left.sourceId, right.sourceId) || compare(left.reason, right.reason))
        .map((omission) => ({
          sourceId: omission.sourceId,
          reason: omission.reason,
          estimatedTokens: omission.estimatedTokens
        }))
    },
    diagnostics: [...contextPackage.diagnostics]
      .sort((left, right) =>
        compare(left.code, right.code) ||
        compare(left.sourceId ?? "", right.sourceId ?? "") ||
        compare(left.severity, right.severity) ||
        compare(left.message, right.message)
      )
      .map((diagnostic) => ({
        code: diagnostic.code,
        severity: diagnostic.severity,
        message: diagnostic.message,
        ...(diagnostic.sourceId !== undefined ? { sourceId: diagnostic.sourceId } : {})
      }))
  };

  return createHash("sha256").update(JSON.stringify(semantic), "utf8").digest("hex");
}

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
